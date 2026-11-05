import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Bot, Trash2 } from 'lucide-react';
import type { SendAttachment } from '@/components/capsule/types';
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
import { AiCollabView } from '@/components/ai-chat/AiCollabView';
import { useAiCollab } from '@/core/ai/aiCollab';
import { useAiWorkProducts } from '@/core/ai/aiWorkProducts';
import type { WorkflowDoc } from '@/core/ai/aiWorkflows';
import {
  createAiWorkTask, workflowFromConv, applyWorkflowToConv, migrateLegacyWorkflows,
} from '@/core/ai/aiWorkTasks';
import { AI_AIWORK_CONVERSATIONS_KEY } from '@/core/ai/util';
import type { AiWorkTab } from '@/components/ai-chat/AiWorkTabs';
import { AiWorkProductSettings } from './AiWorkProductSettings';

const COMPANION_ENABLED_KEY = 'andeyunhui.aichat.companion.enabled';
function readCompanionEnabled(): boolean {
  try { return localStorage.getItem(COMPANION_ENABLED_KEY) === '1'; } catch { return false; }
}

// ===== 命令面板 provider：AI 对话 › 会话；AI 办公 › 任务 =====
// 直接读持久化历史（与主窗口同键），带 TTL；面板打开时 refresh。
const AI_CHAT_KEY = 'andeyunhui.capsule.conversations';
const AI_WORK_KEY = 'andeyunhui.aiwork.conversations';
const AI_PALETTE_TTL = 10_000;

interface PaletteConv {
  id: string;
  title?: string;
  updatedAt?: number;
  messages?: Array<{ role?: string; content?: string }>;
}
interface PaletteConvEntry {
  conv: PaletteConv;
  submodule: 'chat' | 'work';
  label: string;
  /**
   * 快照期就摊平好的匹配素材（小写）。
   * 原来每次按键都要对每个会话 slice(-6) + join + slice(600) + toLowerCase，
   * 会话一多就是 ctrl+k 打字卡顿的主项之一；挪到 TTL 到点重建时才算一次。
   */
  title: string;
  recent: string;
}

let paletteConvs: PaletteConvEntry[] = [];
let paletteConvsAt = 0;

function readConvList(key: string): PaletteConv[] {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((c): c is PaletteConv => !!c && typeof c.id === 'string') : [];
  } catch { return []; }
}

function toPaletteEntry(conv: PaletteConv, submodule: 'chat' | 'work', label: string): PaletteConvEntry {
  return {
    conv,
    submodule,
    label,
    title: conv.title || '新对话',
    recent: (conv.messages ?? [])
      .slice(-6)
      .map((m) => m.content ?? '')
      .join('\n')
      .slice(0, 600)
      .toLowerCase(),
  };
}

function ensurePaletteConvs(force = false): void {
  if (!force && paletteConvsAt > 0 && Date.now() - paletteConvsAt < AI_PALETTE_TTL) return;
  paletteConvs = [
    ...readConvList(AI_CHAT_KEY).map((conv) => toPaletteEntry(conv, 'chat', '对话')),
    ...readConvList(AI_WORK_KEY).map((conv) => toPaletteEntry(conv, 'work', '任务')),
  ];
  paletteConvsAt = Date.now();
}

try {
  window.__HOST_API__?.registerCommandProvider?.({
    id: 'ai-chat',
    label: 'AI 对话',
    moduleId: 'ai-chat',
    priority: 20,
    refresh: () => ensurePaletteConvs(),
    search: (query) => {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      ensurePaletteConvs();
      const out: Array<{
        id: string;
        title: string;
        subtitle?: string;
        path?: string[];
        iconName?: string;
        rank?: number;
        navigate?: NavigationTarget;
        run?: () => void;
      }> = [];
      // 用全站统一的打分器挑「最好的 40 条」，而不是「遍历到的前 40 条命中」；
      // 正文命中打 5 折，让标题命中的排在前面（正文素材已在快照期摊平好）。
      const score = window.__HOST_API__.makeScorer(query);
      const ranked = paletteConvs
        .map((e) => {
          const titleScore = score(e.title);
          return { e, s: Math.max(titleScore, score(e.recent) * 0.5), titleHit: titleScore > 150 };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40);
      for (const { e: entry, titleHit } of ranked) {
        const { conv, submodule, label } = entry;
        const title = entry.title;
        out.push({
          id: `${submodule}:${conv.id}`,
          title,
          subtitle: submodule === 'work' ? 'AI 办公 · 任务' : 'AI 对话',
          path: submodule === 'work' ? ['AI 办公', label] : ['对话'],
          iconName: 'Bot',
          rank: titleHit ? 8 : 0,
          navigate: {
            module: 'ai-chat',
            tabs: submodule === 'work' ? ['AI 办公', label] : ['对话'],
            entity: conv.id,
            props: { submodule, conversationId: conv.id },
          },
          run: () => window.dispatchEvent(new CustomEvent('andy:ai-chat-open', {
            detail: { submodule, conversationId: conv.id },
          })),
        });
      }
      return out;
    },
  });
} catch (err) {
  console.warn('[ai-chat] 命令面板 provider 注册失败:', err);
}

declare const window: Window & { __PLUGIN_REGISTRY__?: { register: (p: Record<string, unknown>) => void } };

const Root = memo(function Root() {
  // 一次性把旧版 AIWorkflow 独立任务迁移进统一任务列表（幂等，须在 aiWorkChat 初始化前执行）
  migrateLegacyWorkflows();

  // 逻辑单例：侧栏与主区共享同一份 useAiChat，避免状态分裂
  const {
    conversations, activeId, activeConv, busy, profileId,
    selectConv, newConversation, newGroup, deleteConversation, renameConversation, clearAll, send, abort, webSearch, setWebSearch, effort, setEffort,
    regenerate, switchVersion, rateMessage,
    decidePlan,
  } = useAiChat({ persistKey: DEFAULT_PERSIST_KEY });

  // AIWork 统一任务实例：与主「AI 对话」彻底隔离，专属存储 key，侧栏任务区 / 对话工作台 / 蓝图画布共用。
  // allowEmpty = 与 AIWorkflow 一致：没任务不再自动保留保底会话，由 UI 提示「创建任务」。
  const aiWorkChat = useAiChat({ persistKey: AI_AIWORK_CONVERSATIONS_KEY, allowEmpty: true });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [companionEnabled, setCompanionEnabled] = useState(readCompanionEnabled);

  // 子模块切换（桌面版）：chat / work / workflow / collab。胶囊浮岛不接入，保持现有 ai 对话。
  const [subId, setSubId] = useState<AISubmoduleId>(() => {
    const raw = (() => { try { return localStorage.getItem(SUBMODULE_STORAGE_KEY); } catch { return null; } })();
    return (raw === 'work' || raw === 'workflow' || raw === 'collab' || raw === 'chat') ? raw : 'chat';
  });
  const [subDrawerOpen, setSubDrawerOpen] = useState(false);
  // work / workflow 子模块内容区分段（任务区 / 产物区），受控于宿主；切换覆盖的是侧栏列表。
  const [area, setArea] = useState<AiWorkTab>('task');
  const sub = submoduleById(subId);
  const switchSub = (id: AISubmoduleId) => {
    setSubId(id);
    setSettingsOpen(false);
    setArea('task'); // 切换子模块时回到任务区
    try { localStorage.setItem(SUBMODULE_STORAGE_KEY, id); } catch { /* 忽略 */ }
  };

  // 统一导航契约：命令面板/其它模块可直达「AI 对话 › 某会话」或「AI 办公 › 任务」。
  // 处理器通过 ref 读取最新闭包，只注册一次；旧宿主仍可用 DOM 事件兜底。
  const navRef = useRef<(target: NavigationTarget) => boolean>(() => false);
  navRef.current = (target) => {
    const props = (target.props ?? {}) as { submodule?: AISubmoduleId; conversationId?: string };
    const rawSub = props.submodule ?? (target.tabs?.[0] === 'AI 办公' ? 'work' : 'chat');
    const subTarget: AISubmoduleId = rawSub === 'work' || rawSub === 'workflow' || rawSub === 'collab' ? rawSub : 'chat';
    const convId = props.conversationId ?? target.entity;
    switchSub(subTarget);
    if (convId) {
      if (subTarget === 'chat') selectConv(convId);
      else aiWorkChat.selectConv(convId);
    }
    return true;
  };
  useEffect(() => {
    const off = window.__HOST_API__?.registerNavigator?.((target) => navRef.current(target));
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ submodule?: AISubmoduleId; conversationId?: string }>).detail;
      if (detail) navRef.current({ module: 'ai-chat', props: detail });
    };
    window.addEventListener('andy:ai-chat-open', onEvent);
    return () => {
      try { off?.(); } catch { /* 忽略 */ }
      window.removeEventListener('andy:ai-chat-open', onEvent);
    };
    // 处理器走 ref，只注册一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // work / workflow 子模块状态：产物库 + 统一任务（AIWork 对话 与 AIWorkflow 蓝图共用的同一条任务）托管于此，
  // 复用的共享侧栏（AiChatSidebar）与各视图共用同一份数据，不再自建第二层侧栏。
  const productStore = useAiWorkProducts();
  // AI 协作（P0）：房间列表 + 事件流由独立 crate 提供，前端只消费快照与事件。
  const collab = useAiCollab();
  const changeArea = useCallback((t: AiWorkTab) => {
    setArea(t);
    if (t === 'task') productStore.back(); // 切回任务区时清空查看态
  }, [productStore.back]);
  useEffect(() => {
    if (productStore.viewing) setArea('product'); // 侧栏点选产物 → 自动切到产物区
  }, [productStore.viewing]);

  // —— 统一任务：AIWork 对话 与 AIWorkflow 蓝图编辑同一条 Conversation（aiWork 字段） ——
  /** 新建统一任务（带默认起始蓝图），AIWork / AIWorkflow 共用 */
  const newTask = useCallback(() => {
    aiWorkChat.newConversation(createAiWorkTask());
  }, [aiWorkChat.newConversation]);
  /** 当前活动任务对应的 AIWorkflow 文档（节点画布渲染用） */
  const activeTaskConv = aiWorkChat.conversations.find((c) => c.id === aiWorkChat.activeId) ?? null;
  const wfDoc = useMemo(
    () => (activeTaskConv ? workflowFromConv(activeTaskConv) : null),
    [activeTaskConv],
  );
  /** AIWorkflow 画布编辑 → 回写统一任务的 aiWork 蓝图 */
  const updateWorkflow = useCallback((fn: (d: WorkflowDoc) => WorkflowDoc) => {
    const id = aiWorkChat.activeId;
    if (!id) return;
    aiWorkChat.patchConv(id, (c) => applyWorkflowToConv(c, fn(workflowFromConv(c))));
  }, [aiWorkChat.activeId, aiWorkChat.patchConv]);

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
  // excludeGlobalPersona=true：伴侣模式下跳过「全局 AI 人设」，只走伴侣人设，
  // 逻辑上「ai 对话启动伴侣模式后仅遵循伴侣设定、不受全局人设控制」。
  // ★ 必须转发 images / attachments：这个包装原先签名只有 `(text)`，
  //   AiChatConversation 调的是 send(text, images, attachments) ⇒ **图片与附件被静默丢掉**，
  //   表现就是"对话框里有图，发出去只剩文字，模型也说没收到图"（2026-10-28 用户实测）。
  const sendWithCompanion = useCallback(
    (text: string, images?: string[], attachments?: SendAttachment[]) => {
      if (!(companionEnabled && companion)) return send(text, images, attachments);
      const personaPrompt = buildPersonaContext(companion);
      const corePrompt = buildCoreContext(companion);
      return send(text, images, attachments, {
        ...(personaPrompt ? { personaPrompt } : {}),
        ...(corePrompt ? { systemPrompt: corePrompt } : {}),
        excludeGlobalPersona: true,
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
        onNew={() => newConversation()}
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
        area={area}
        onAreaChange={changeArea}
        work={{
          sessions: aiWorkChat.conversations,
          activeSessionId: aiWorkChat.activeId,
          onSelectSession: aiWorkChat.selectConv,
          onNewSession: newTask,
          onDeleteSession: aiWorkChat.deleteConversation,
          onRenameSession: aiWorkChat.renameConversation,
          products: productStore.products,
          viewingId: productStore.viewing?.id ?? null,
          onView: productStore.view,
          onArchive: productStore.archive,
          onFav: productStore.fav,
          onPending: productStore.pending,
          onDeleteProduct: productStore.remove,
        }}
        collab={{
          rooms: collab.rooms,
          activeRoomId: collab.activeRoom?.id ?? null,
          onSelectRoom: (id) => void collab.selectRoom(id),
          onNewRoom: () => void collab.createRoom(),
          deepseekAvailable: collab.harnesses.find((h) => h.id === 'dsh')?.available ?? false,
          onNewDeepSeekRoom: () => void collab.createRoom(undefined, 'dsh'),
          onDeleteRoom: (id) => void collab.deleteRoom(id),
        }}
      />
      {settingsOpen ? (
        // AI 协作：设置页只读展示 harness 接入路线（P1：Echo + DeepSeek 本地）。
        sub.id === 'collab' ? (
          <ModuleSettingsPanel title="AI 协作" icon={sub.icon} onClose={() => setSettingsOpen(false)}>
            <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
              <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">Harness 接入</div>
              <div className="mt-0.5 text-xs text-neutral-400 dark:text-stone-500">
                P2 已接入 DeepSeek Harness（headless + ACP 原位恢复，本地模型）；下列条目是后续接入路线。
              </div>
            </div>
            <div className="space-y-2">
              {collab.harnesses.map((harness) => (
                <div key={harness.id} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-neutral-800 dark:text-stone-100">{harness.name}</span>
                    <span className={`ml-auto text-[10px] ${harness.available ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400 dark:text-stone-500'}`}>
                      {harness.available ? '可用' : '未接入'}
                    </span>
                  </div>
                  <div className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-stone-400">{harness.detail}</div>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-black/10 p-3 text-xs leading-relaxed text-neutral-500 dark:border-white/10 dark:text-stone-400">
              共享会话镜像：绑定了工作目录的房间会把事件流写到
              <span className="mx-1 rounded bg-neutral-100 px-1 py-0.5 font-mono text-[10px] dark:bg-stone-800">
                &lt;workspace&gt;/.adyh/collab/rooms/&lt;id&gt;/
              </span>
              ，其它 harness 读取 `events.ndjson` 即可扫描，往 `inbox/` 写 JSON 即可发言。
            </div>
          </ModuleSettingsPanel>
        ) : sub.id === 'work' || sub.id === 'workflow' ? (
          // AI 办公 / AI 工作流：设置与「AI 对话」隔离 —— 只暴露 AIGC 产物/任务相关设置，
          // 不混杂主对话的「伴侣 / 记忆 / 清除对话」等 AI 对话专属项。
          <ModuleSettingsPanel title={sub.name} icon={sub.icon} onClose={() => setSettingsOpen(false)}>
            <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
              <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">{sub.name} 设置</div>
              <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">
                任务区 / 产物区设置对 AI 办公与 AI 工作流统一生效，与「AI 对话」模块相互隔离
              </div>
            </div>
            <AiWorkProductSettings />
          </ModuleSettingsPanel>
        ) : (
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
        </ModuleSettingsPanel>
        )
      ) : sub.id === 'chat' ? (
        <AiChatConversation
          activeConv={activeConv}
          busy={busy}
          profileId={profileId}
          send={sendWithCompanion}
          onStop={abort}
          effort={effort}
          onEffortChange={setEffort}
          webSearch={webSearch}
          onToggleWebSearch={setWebSearch}
          onRegenerate={(id) => void regenerate(id)}
          onSwitchVersion={switchVersion}
          onRate={rateMessage}
          onPlanDecision={(id, ok) => decidePlan(id, ok)}
          onClear={() => deleteConversation(activeId)}
          companionCard={companionEnabled ? (
            <AiChatCompanionCard variant="compact" onEdit={() => setSettingsOpen(true)} />
          ) : undefined}
          showCompanionAvatar={companionEnabled}
        />
      ) : sub.id === 'work' ? (
      <AiWorkView
        profileId={aiWorkChat.profileId}
        products={productStore.products}
        onSaveOutput={productStore.save}
        activeConv={aiWorkChat.activeConv}
        busy={aiWorkChat.busy}
        send={aiWorkChat.send}
        onStop={aiWorkChat.abort}
        effort={aiWorkChat.effort}
        onEffortChange={aiWorkChat.setEffort}
        webSearch={aiWorkChat.webSearch}
        onToggleWebSearch={aiWorkChat.setWebSearch}
        onRegenerate={(id) => void aiWorkChat.regenerate(id)}
        onSwitchVersion={aiWorkChat.switchVersion}
        onRate={aiWorkChat.rateMessage}
        onPlanDecision={(id, ok) => aiWorkChat.decidePlan(id, ok)}
        conversations={aiWorkChat.conversations}
        onSelectConv={aiWorkChat.selectConv}
        onNewConv={newTask}
        onDeleteConv={aiWorkChat.deleteConversation}
        onRenameConv={aiWorkChat.renameConversation}
      />
    ) : sub.id === 'workflow' ? (
      <AiWorkflowView
        profileId={profileId}
        doc={wfDoc}
        onUpdate={updateWorkflow}
      />
    ) : sub.id === 'collab' ? (
      <AiCollabView
        room={collab.activeRoom}
        events={collab.events}
        assignments={collab.assignments}
        busy={collab.busy}
        error={collab.error}
        onCreateRoom={() => void collab.createRoom()}
        onCreateDeepSeekRoom={() => void collab.createRoom(undefined, 'dsh')}
        deepseekAvailable={collab.harnesses.find((h) => h.id === 'dsh')?.available ?? false}
        dshSessions={collab.dshSessions}
        dshSessionsLoading={collab.dshSessionsLoading}
        onLoadDshSessions={() => void collab.loadDshSessions()}
        onImportDshSession={(id) => void collab.importDshSession(id)}
        onSetWorkspace={(path) => void collab.setWorkspace(path)}
        onSend={(text) => void collab.send(text)}
        onDemo={() => void collab.runDemo()}
        onCancel={(id) => void collab.cancel(id)}
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
