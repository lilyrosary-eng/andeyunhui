import { memo, useState, useEffect, useCallback } from 'react';
import { Bot, Trash2 } from 'lucide-react';
import { AiChatSidebar } from '@/components/ai-chat/AiChatSidebar';
import { AiChatConversation } from '@/components/ai-chat/AiChatConversation';
import { AiChatCompanionCard } from '@/components/ai-chat/AiChatCompanionCard';
import { AiChatCompanionSettings } from '@/components/ai-chat/settings/AiChatCompanionSettings';
import { AiChatMemorySettings } from '@/components/ai-chat/settings/AiChatMemorySettings';
import { UserAvatarSettings } from '@/components/bricks/UserAvatarSettings';
import { ModuleSettingsPanel } from '@/components/ModuleSettingsPanel';
import { useAiChat, DEFAULT_PERSIST_KEY } from '@/core/ai/useAiChat';
import { useCompanionStore, buildPersonaContext, buildCoreContext } from '@/core/stores/companionStore';
import { submoduleById, type AISubmoduleId, SUBMODULE_STORAGE_KEY } from '@/core/ai/submodules';
import { AISubmoduleDrawer } from '@/components/ai-chat/AISubmoduleSwitcher';
import { AiSubmodulePlaceholder } from '@/components/ai-chat/AiSubmodulePlaceholder';
import { AiWorkView } from '@/components/ai-chat/AiWorkView';
import { AiWorkflowView } from '@/components/ai-chat/AiWorkflowView';
import { useAiWorkProducts } from '@/core/ai/aiWorkProducts';
import { useAiWorkflows } from '@/core/ai/aiWorkflows';
import type { AiWorkTab } from '@/components/ai-chat/AiWorkTabs';

const COMPANION_ENABLED_KEY = 'andeyunhui.aichat.companion.enabled';
function readCompanionEnabled(): boolean {
  try { return localStorage.getItem(COMPANION_ENABLED_KEY) === '1'; } catch { return false; }
}

declare const window: Window & { __PLUGIN_REGISTRY__?: { register: (p: Record<string, unknown>) => void } };

const Root = memo(function Root() {
  // 逻辑单例：侧栏与主区共享同一份 useAiChat，避免状态分裂
  const {
    conversations, activeId, activeConv, busy, profileId,
    selectConv, newConversation, newGroup, deleteConversation, renameConversation, clearAll, send, agent, setAgent,
  } = useAiChat({ persistKey: DEFAULT_PERSIST_KEY });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [companionEnabled, setCompanionEnabled] = useState(readCompanionEnabled);

  // 子模块切换（桌面版）：chat / work / workflow。胶囊浮岛不接入，保持现有 ai 对话。
  const [subId, setSubId] = useState<AISubmoduleId>(() => {
    const raw = (() => { try { return localStorage.getItem(SUBMODULE_STORAGE_KEY); } catch { return null; } })();
    return (raw === 'work' || raw === 'workflow' || raw === 'chat') ? raw : 'chat';
  });
  const [subDrawerOpen, setSubDrawerOpen] = useState(false);
  // workflow 内容区分段（任务区/产物区），受控于宿主
  const [wfTab, setWfTab] = useState<AiWorkTab>('task');
  const sub = submoduleById(subId);
  const switchSub = (id: AISubmoduleId) => {
    setSubId(id);
    setSettingsOpen(false);
    setWfTab('task'); // 切换子模块时，工作流的任务/产物区回到任务区
    try { localStorage.setItem(SUBMODULE_STORAGE_KEY, id); } catch { /* 忽略 */ }
  };

  // work / workflow 子模块状态：产物库 + 工作流任务统一托管于此，
  // 复用的共享侧栏（AiChatSidebar）与各视图共用同一份数据，不再自建第二层侧栏。
  const productStore = useAiWorkProducts();
  const wf = useAiWorkflows();
  const wfChangeTab = useCallback((t: AiWorkTab) => {
    setWfTab(t);
    if (t === 'task') productStore.back(); // 切回任务区时清空查看态
  }, [productStore.back]);
  useEffect(() => {
    if (productStore.viewing) setWfTab('product'); // 侧栏点选产物 → 自动切到产物区
  }, [productStore.viewing]);

  // 复用侧边栏模块设置齿轮（#13）：宿主齿轮点击派发 module-settings-toggle 事件，
  // 此处监听并切换 ai-chat 独立设置面板，第二次点击即关闭（对齐其它子插件实现）。
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent<{ moduleId?: string }>).detail;
      if (detail && detail.moduleId && detail.moduleId !== 'ai-chat') return;
      setSettingsOpen((o) => !o);
    };
    window.addEventListener('module-settings-toggle', h);
    return () => window.removeEventListener('module-settings-toggle', h);
  }, []);

  const companion = useCompanionStore((s) => s.companion);
  const loadCompanions = useCompanionStore((s) => s.load);
  useEffect(() => { void loadCompanions(); }, [loadCompanions]);

  // 启用伴侣时，发送消息注入伴侣上下文（仅影响 ai-chat 模块，不影响 ai编程/ai攻防）
  // 方案 B：人设画像(persona) 作为最高优先级记忆置顶，L2 核心档案(core) 列于其后。
  const sendWithCompanion = useCallback(
    (text: string) => {
      if (!(companionEnabled && companion)) return send(text);
      const personaPrompt = buildPersonaContext(companion);
      const corePrompt = buildCoreContext(companion);
      return send(text, {
        ...(personaPrompt ? { personaPrompt } : {}),
        ...(corePrompt ? { systemPrompt: corePrompt } : {}),
      });
    },
    [send, companionEnabled, companion],
  );

  const toggleCompanion = () => {
    const next = !companionEnabled;
    setCompanionEnabled(next);
    try { localStorage.setItem(COMPANION_ENABLED_KEY, next ? '1' : '0'); } catch { /* 忽略 */ }
  };

  return (
    <div className="relative flex-1 flex h-full overflow-hidden">
      <AiChatSidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConv}
        onNew={newConversation}
        onNewGroup={newGroup}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onOpenModuleSettings={() => {
          // 模块设置按钮也走同一 CustomEvent，让 Root 统一 toggle；
          // 这样在设置面板打开后再次点击会执行退出（对齐其它子插件的预期交互）。
          window.dispatchEvent(new CustomEvent('module-settings-toggle', { detail: { moduleId: 'ai-chat' } }));
        }}
        submodule={sub}
        onOpenSubmoduleSwitcher={() => setSubDrawerOpen(true)}
        work={{
          products: productStore.products,
          viewingId: productStore.viewing?.id ?? null,
          onView: productStore.view,
          onDeleteProduct: productStore.remove,
        }}
        workflow={{
          workflows: wf.workflows,
          activeId: wf.activeId,
          onSelect: wf.selectWorkflow,
          onNew: wf.newWorkflow,
          onRename: wf.renameWorkflow,
          onDelete: wf.removeWorkflow,
        }}
        productMode={subId === 'workflow' && wfTab === 'product'}
      />
      {sub.id === 'chat' ? (
      settingsOpen ? (
        <ModuleSettingsPanel title="AI 对话" icon={<Bot size={20} />} onClose={() => setSettingsOpen(false)}>
          <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">启用伴侣</div>
                <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">
                  启用后「AI 对话」走伴侣人设，其它 AI（AI 编程 / AI 攻防）仍走全局设置
                </div>
              </div>
              <input type="checkbox" className="h-5 w-5 accent-sky-500" checked={companionEnabled} onChange={toggleCompanion} />
            </label>
          </div>

          {/* 用户头像设置：独立于"启用伴侣"开关，永远可编辑 */}
          <UserAvatarSettings />

          {/* 启用伴侣关闭时，伴侣设置 + 记忆设置的整体被浅遮罩 + 锁交互，
              避免用户误改但仍可预览（开关本身上方可自由切换） */}
          <fieldset
            disabled={!companionEnabled}
            className="relative m-0 min-w-0 rounded-2xl border border-transparent p-0 disabled:cursor-not-allowed"
          >
            <legend className="sr-only">伴侣相关设置</legend>
            <div className="space-y-4">
              <AiChatCompanionSettings />
              <AiChatMemorySettings />
            </div>
            {!companionEnabled && (
              <div
                aria-hidden
                className="pointer-events-auto absolute inset-0 z-10 flex items-start justify-center rounded-2xl bg-neutral-100/60 backdrop-blur-[2px] dark:bg-stone-900/60"
              >
                <div className="mt-6 rounded-full border border-neutral-300 bg-white/80 px-3 py-1 text-xs text-neutral-500 shadow-sm dark:border-white/10 dark:bg-stone-800/80 dark:text-stone-400">
                  启用伴侣后可编辑
                </div>
              </div>
            )}
          </fieldset>

          <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">清除所有对话</div>
                <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">将删除全部会话历史，且不可恢复</div>
              </div>
              <button
                onClick={() => { clearAll(); setSettingsOpen(false); }}
                className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-red-500 border border-red-500/30 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={15} /> 清除
              </button>
            </div>
          </div>
          <div className="text-xs text-neutral-400 dark:text-stone-500">
            当前共 {conversations.length} 段对话。AI 对话由统一 AI 核心驱动，模型与开关在「全局设置 → 模型」中配置。
          </div>
        </ModuleSettingsPanel>
      ) : (
        <AiChatConversation
          activeConv={activeConv}
          busy={busy}
          profileId={profileId}
          send={sendWithCompanion}
          agent={agent}
          onToggleAgent={setAgent}
          onClear={() => deleteConversation(activeId)}
          companionCard={companionEnabled ? (
            <AiChatCompanionCard variant="compact" onEdit={() => setSettingsOpen(true)} />
          ) : undefined}
          showCompanionAvatar={companionEnabled}
        />
      )
    ) : sub.id === 'work' ? (
      <AiWorkView
        products={productStore.products}
        viewing={productStore.viewing}
        onSaveOutput={productStore.save}
        onDeleteProduct={productStore.remove}
        onBack={productStore.back}
      />
    ) : sub.id === 'workflow' ? (
      <AiWorkflowView
        profileId={profileId}
        doc={wf.active}
        onUpdate={wf.updateActive}
        viewing={productStore.viewing}
        onDeleteProduct={productStore.remove}
        tab={wfTab}
        onTabChange={wfChangeTab}
      />
    ) : (
        <AiSubmodulePlaceholder mod={sub} />
      )}
      {subDrawerOpen && (
        <AISubmoduleDrawer
          open={subDrawerOpen}
          current={subId}
          onSelect={switchSub}
          onClose={() => setSubDrawerOpen(false)}
        />
      )}
    </div>
  );
});

Root.displayName = 'AiChatRoot';

window.__PLUGIN_REGISTRY__?.register({
  id: 'ai-chat',
  name: 'AI 对话',
  kind: 'module',
  visible: true,
  iconName: 'Bot',
  desc: '独立 AI 对话模块，多会话管理，由统一 AI 核心驱动',
  component: Root,
});

export default Root;
