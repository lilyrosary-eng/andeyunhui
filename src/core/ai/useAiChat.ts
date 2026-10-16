// AI 对话核心逻辑 Hook —— 胶囊浮窗与独立「AI 对话」模块共用的纯逻辑层。
// 不渲染任何 UI：管理多会话 state、localStorage 持久化、流式事件接线、发送。
// UI 由调用方自行设计：主窗口用双栏 AiChatSidebar + AiChatConversation；胶囊复用同一套 AiChatConversation（capsuleMode 形态）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMsg, Conversation, SendAttachment, AttachmentMeta } from '@/components/capsule/types';
import { useAiStream } from '@/components/capsule/useAiStream';
import { EVENTS } from '@/core/events/schema';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { uid, persistConversations, loadConversations, genTitle, makeConv, makeGroupConv, mergeConversations, AI_CHAT_CONVERSATIONS_KEY } from '@/core/ai/util';
import { resolveMediaConfig } from '@/core/ai/media/resolve';
import { retrieveChatContext, ingestChatTurn } from '@/core/stores/semanticMemory';
import { useCompanionStore, buildPersonaContext } from '@/core/stores/companionStore';

/**
 * agent 单次请求的**最大工具轮数**上限/默认值。
 *
 * 与 Rust `ai_agent::run_agent` 的 `clamp(1, 20)` 是**同一个界**，改一处要改两处。
 * 默认 8：够普通问答与一次查询；"自己搭 ComfyUI 工作流"这类要查节点+查模型+建图+
 * 按报错重试+自检，8 轮偏紧，所以做成可调而不是写死。
 */
export const AGENT_ROUNDS_MAX = 20;
export const AGENT_ROUNDS_DEFAULT = 8;

/** 读当前设置（非法值回落到默认 —— 存储被手改坏不该让请求发不出去）。 */
export function agentMaxRounds(): number {
  const raw = Number(storage.getString(KEYS.ai.agentMaxRounds.key, String(AGENT_ROUNDS_DEFAULT)));
  if (!Number.isFinite(raw)) return AGENT_ROUNDS_DEFAULT;
  return Math.min(AGENT_ROUNDS_MAX, Math.max(1, Math.trunc(raw)));
}

export const DEFAULT_PERSIST_KEY = AI_CHAT_CONVERSATIONS_KEY;

/** 永久对话记忆开关（localStorage，默认开）。与 AiChatMemorySettings 共用同一 key。 */
export const AI_CHAT_MEMORY_KEY = KEYS.desktop.aiChatMemory.key;
export function getAiChatMemoryEnabled(): boolean {
  return storage.getString(AI_CHAT_MEMORY_KEY, 'true') !== 'false';
}
export function setAiChatMemoryEnabled(on: boolean) {
  storage.setString(AI_CHAT_MEMORY_KEY, on ? 'true' : 'false');
}
// 跨 window 同步事件名：依 persistKey 分区派生，避免同一 webview 内多个 useAiChat 实例
// （chat 与 AIWork 独立实例）监听同一全局事件互相 merge 串号。
const syncEventFor = (key: string) => `ai-chat:conv-sync:${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const syncReqEventFor = (key: string) => `ai-chat:conv-req:${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

// 每次请求携带的历史消息上限（尾部截断），防止长对话 / 群聊累计历史超出模型上下文上限
// （曾因群聊全量历史塞入单请求导致 209 万 token 触发 HTTP 400）。system 人设单独传，不受此限。
const CHAT_HISTORY_LIMIT = 40; // 单对单：轮次线性增长，可放宽
const GROUP_HISTORY_LIMIT = 16; // 群聊：每轮历史含所有伴侣回复，膨胀更快，收紧窗口

// 请求前硬防御：与后端 truncate_messages_for_safety 双保险。
// 旧 bundle（未重建）可能未走 GROUP_HISTORY_LIMIT 条数截断，或某条 content 被重复
// 拼接撑到百万字符；此处按"真实字符估算 token"兜底，确保绝不可能把 >HARD_TOTAL_CAP
// 的请求送出去。诊断日志用于坐实真实条数 / 最大单条长度（区分「条数失控」还是「单条巨 content」）。
const HARD_MSG_CAP = 8_000; // 单条 content 硬切（字符）
const HARD_TOTAL_CAP = 200_000; // 总 token 硬切（远低于模型上限 1048576）

function estTokens(s: string): number {
  const cjk = (s.match(/[　-鿿＀-￯]/g) || []).length;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

function safeMessages(msgs: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  let total = 0;
  let maxLen = 0;
  const rawTotalChars = msgs.reduce((s, m) => s + (m.content?.length || 0), 0);
  const out: Array<{ role: string; content: string }> = [];
  for (const m of [...msgs].reverse()) {
    let content = typeof m.content === 'string' ? m.content : '';
    if (content.length > maxLen) maxLen = content.length;
    if (content.length > HARD_MSG_CAP) content = content.slice(0, HARD_MSG_CAP) + '…（超长已截断）';
    const t = estTokens(content);
    if (total + t > HARD_TOTAL_CAP) break; // 从尾部取，总超则停止（保留最近若干条）
    out.unshift({ role: m.role, content });
    total += t;
  }
  // 始终打印一次（即便未截断）：用于排查 messages 总规模是否真的进入上游。
  console.log(
    `[ai-chat] safeMessages: 原始条数=${msgs.length} 原始总字符=${rawTotalChars} 裁剪后=${out.length} 最大单条字符=${maxLen} 估算总token≈${total}`,
  );
  if (msgs.length > out.length || maxLen > HARD_MSG_CAP) {
    console.error(
      `[ai-chat] 请求前硬截断生效：原始条数=${msgs.length} 裁剪后=${out.length} 最大单条字符=${maxLen} 估算总token≈${total}。`
      + `若原始条数远大于 ${GROUP_HISTORY_LIMIT} 或最大单条接近 ${HARD_MSG_CAP}，说明存在重复拼接/旧bundle未重建。`,
    );
  }
  return out;
}

export interface UseAiChatOptions {
  /** localStorage 持久化键，不同入口用不同键避免串号（胶囊 / AI 对话模块 / 其他浮窗） */
  persistKey?: string;
  /**
   * 人设画像（persona）系统提示 —— 方案 B：最稳定、优先级最高的记忆，
   * 永远排在 system 最前面（先于 systemPrompt 与检索记忆），保证人设不串味。
   * 通常由伴侣模块用 buildPersonaContext(companion) 生成；不传则跳过。
   */
  personaPrompt?: string;
  /** 注入的 system 指令（可选，留空则用后端默认）。位于 personaPrompt 之后、检索记忆之前。 */
  systemPrompt?: string;
  /**
   * 伴侣模式：为 true 时请求后端跳过「全局 AI 人设」（AiProfile.persona），
   * 只使用本调用注入的伴侣人设 —— 满足「ai 对话启动伴侣模式后只走伴侣人设、不受全局 AI 人设控制」。
   */
  excludeGlobalPersona?: boolean;
  /**
   * Agent 工具模式开关（默认 false = 纯对话）。为 true 时调用走 ai_chat_agent：
   * 由后端挂载全套工具（web_search/web_fetch/file/grep/glob/plan 等），让对话具备联网/执行能力。
   * 事件契约与 ai_chat 相同（ai-done/ai-error），仅新增 ai-agent-step 工具步骤事件。
   */
  agent?: boolean;
  /**
   * 是否允许空会话列表（默认 false）。为 true 时若持久化数据为空则不自动创建保底会话，
   * 直接保持空列表（activeId 为空串）——用于 AIWork 统一任务区：没任务时由 UI 提示「创建任务」。
   * 主「AI 对话」保持 false（始终至少一个会话）。
   */
  allowEmpty?: boolean;
}

export interface UseAiChatResult {
  conversations: Conversation[];
  activeId: string;
  activeConv: Conversation | null;
  busy: boolean;
  ready: boolean;
  profileId: string;
  /** 是否 Agent 工具模式（联网/工具）。开=走 ai_chat_agent；关=纯对话。 */
  agent: boolean;
  setAgent: (on: boolean) => void;
  selectConv: (id: string) => void;
  newConversation: (seed?: Partial<Conversation>) => string;
  newGroup: (participantIds: string[], groupName?: string) => string;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  /** 对某条会话做不可变更新（自动 bump updatedAt）。AIWork 统一任务回写蓝图用。 */
  patchConv: (id: string, fn: (c: Conversation) => Conversation) => void;
  /** 当前会话的思考档位覆盖（''= 跟随配置）。 */
  effort: string;
  /** 改当前会话的思考档位覆盖（对话页的选择器）。 */
  setEffort: (v: string) => void;
  clearAll: () => void;
  /** 发送一条消息。images 为可选的多模态图片（data URL），后端 ai_vision_ocr 生成描述后注入 system。 */
  send: (text: string, images?: string[], attachments?: SendAttachment[]) => Promise<void>;
  /**
   * 停止本轮生成。agent 模式走 `ai_agent_cancel`，纯对话走 `ai_chat_cancel`。
   * 已收到的部分文本会保留，并补一句「（已停止）」。
   */
  abort: () => void;
  /** 群聊：串行让每位参与者（伴侣）基于「用户这句话 + 此前所有人的回复」各回应一句。 */
  groupSend: (text: string) => Promise<void>;
  /** 群聊内部：让单个发言者说一句（注入其独立人设 system，复用全局流式落盘）。 */
  sendOne: (speakerId: string, history: ChatMsg[]) => Promise<void>;
}

/**
 * 共用 AI 对话逻辑。状态、持久化、流式、发送全在此，调用方只负责把数据画出来。
 */
export function useAiChat(options: UseAiChatOptions = {}): UseAiChatResult {
  const { persistKey = DEFAULT_PERSIST_KEY, personaPrompt, systemPrompt, agent = false, allowEmpty = false, excludeGlobalPersona = false } = options;
  const syncEvent = syncEventFor(persistKey);
  const syncReqEvent = syncReqEventFor(persistKey);
  // Agent 模式需随回调读取最新值（避免闭包陈旧）
  const [agentOn, setAgentOn] = useState<boolean>(agent);
  const agentRef = useRef(agentOn);
  agentRef.current = agentOn;
  const setAgent = useCallback((on: boolean) => {
    setAgentOn(on);
    agentRef.current = on;
  }, []);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [profileId, setProfileId] = useState<string>('');

  // 跨 webview 同步：胶囊浮窗与主窗口是独立 webview（localStorage 隔离），
  // 通过全局事件合并两端会话。applyingRemote 防止收到远端数据后回环广播。
  const myLabel = getCurrentWebviewWindow().label;
  const applyingRemote = useRef(false);

  const activeIdRef = useRef(activeId);
  const busyRef = useRef(false);
  const profileIdRef = useRef<string>('');

  // 会话状态镜像（流式闭包读取用，避免把 conversations 塞进 effect 依赖）
  const stateRef = useRef({ conversations, activeId });
  stateRef.current = { conversations, activeId };

  // 安全更新某会话消息
  const updateMessages = useCallback((convId: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, messages: updater(c.messages) } : c)));
  }, []);

  // 流式事件接线（{prefix:'ai'} 即对话类：append 增量 + 带思考过程）
  const reqRef = useRef<string | null>(null);
  const asstRef = useRef<string | null>(null);
  const streamConvIdRef = useRef<string>('');
  // setBusy 必须是稳定引用：useAiStream 的 effect 依赖它，内联箭头函数会让 effect
  // 随每次渲染重建——流式期间每个 delta 都触发渲染 → 监听器被反复拆卸重装，
  // 异步注册跟不上重建节奏时产生「孤儿监听器」，同一 delta 被 2~3 个监听器重复
  // 追加（流式回复文本重复损坏的根因）。
  const setBusyStable = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);
  useAiStream(
    { prefix: EVENTS.chatStream.prefix, deltaMode: 'append', hasReasoning: true, hasAgentStep: true },
    { reqRef, asstRef, streamConvIdRef, updateMessages, setBusy: setBusyStable },
  );

  /**
   * 停止本轮生成（用户点「停止」）。
   *
   * ## 为什么必须把 reqRef 置空
   * 事件处理（`useAiStream`）按 `requestId === reqRef.current` 过滤。置空后，**本轮**
   * 迟到的 delta / done / error 一律不再匹配 —— 于是收口是**确定性**的，不存在
   * 「标记写完了又被一个迟到的 delta 追加到后面」这种竞态。代价是本轮后续事件全部丢弃，
   * 这正是我们要的（已经在停了）。
   *
   * ## 为什么要本地复位 busy
   * agent 那条链的取消会 `abort.abort()` **强杀**后台任务，任务不再跑到协作点，
   * 于是 `ai-done` 可能永远不来。只依赖后端事件的话，按钮会永久卡在「停止中」。
   * 所以本地复位是兜底，后端事件是补充 —— 两者都幂等。
   *
   * 标记文案沿用本层既有约定（`useAiStream` 的 `（无内容）`、`⚠ ` 同样是硬编码中文）；
   * 非中文环境会看到这句中文，与既有情况一致，登记为已知 i18n 缺口。
   */
  const abort = useCallback(() => {
    const rid = reqRef.current;
    if (!rid) return;
    const aid = asstRef.current;
    const cid = streamConvIdRef.current;
    // 1) 先断掉本轮的事件匹配（确定性收口）
    reqRef.current = null;
    asstRef.current = null;
    // 2) 给已收到的部分补一句「已停止」，让用户知道这条不是完整的回答
    if (aid) {
      updateMessages(cid, (prev) => prev.map((m) => {
        if (m.id !== aid) return m;
        if (m.content.includes('（已停止）')) return m;
        return { ...m, content: (m.content ? m.content + '\n\n' : '') + '（已停止）' };
      }));
    }
    // 3) 本地复位（后端强杀时事件不会来，这一步保证 UI 不卡）
    setBusyStable(false);
    // 4) 通知后端真正停下（省掉剩余 token 与网络等待）；找不到就说明本轮已自然结束，忽略
    void invoke(agentRef.current ? 'ai_agent_cancel' : 'ai_chat_cancel', { requestId: rid }).catch(() => {});
  }, [setBusyStable, updateMessages]);

  // 取当前激活 AI 档案 id（沙箱内 zustand store 隔离，故走 invoke）
  const loadProfile = useCallback(async () => {
    try {
      // 后端用顶层 active 指定当前激活档案（档案上的 enabled 字段并不存在），
      // 故按 active 回落取档案，避免 profileId 为空导致思考开关静默失效。
      const data = await invoke<{ profiles: Array<{ id: string }>; active?: string }>('ai_get_profiles');
      const list = Array.isArray(data?.profiles) ? data.profiles : [];
      const active = (data?.active ? list.find((p) => p.id === data.active) : undefined) ?? list[0];
      const pid = active?.id ?? '';
      profileIdRef.current = pid;
      setProfileId(pid);
    } catch {
      profileIdRef.current = '';
      setProfileId('');
    }
  }, []);

  // 初始化：加载持久化会话 + 档案
  useEffect(() => {
    const loaded = loadConversations(persistKey);
    const initial = loaded.length ? loaded : allowEmpty ? [] : [makeConv()];
    setConversations(initial);
    setActiveId(initial[0]?.id ?? '');
    activeIdRef.current = initial[0]?.id ?? '';
    // 持久化链路即刻就绪：ready 曾绑在 loadProfile（网络 invoke）上，导致 profile
    // 加载期间的会话变更（如刚点「新对话」）不被持久化——切模块后新对话丢失。
    setReady(true);
    void loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey, allowEmpty]);

  // 持久化（会话变化即写本地）；且向其它窗口广播合并（应用远端时不重复广播）
  useEffect(() => {
    if (!ready) return;
    persistConversations(persistKey, conversations);
    if (!applyingRemote.current) {
      void emit(syncEvent, { src: myLabel, conversations }).catch(() => {});
    }
  }, [conversations, persistKey, ready, myLabel, syncEvent]);

  // 监听其它窗口的会话变更，合并进本地（不覆盖对端独有历史）
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let unReq: UnlistenFn | undefined;
    listen<{ src: string; conversations: Conversation[] }>(syncEvent, (e) => {
      if (e.payload.src === myLabel) return;
      applyingRemote.current = true;
      setConversations((local) => mergeConversations(local, e.payload.conversations));
      setTimeout(() => { applyingRemote.current = false; }, 0);
    }).then((u) => { un = u; });
    // 收到拉取请求 → 回复本端全量（让对端获得已有历史，解决"打开即同步"）
    listen<{ src: string }>(syncReqEvent, (e) => {
      if (e.payload.src === myLabel) return;
      if (applyingRemote.current) return;
      const snapshot = stateRef.current.conversations;
      if (!snapshot.length) return;
      void emit(syncEvent, { src: myLabel, conversations: snapshot }).catch(() => {});
    }).then((u) => { unReq = u; });
    return () => { un?.(); unReq?.(); };
  }, [myLabel, syncEvent, syncReqEvent]);

  // 挂载时主动拉取另一端已有历史（胶囊与主窗口独立 webview，localStorage 隔离）
  useEffect(() => {
    void emit(syncReqEvent, { src: myLabel }).catch(() => {});
  }, [myLabel, syncReqEvent]);

  const selectConv = useCallback((id: string) => {
    setActiveId(id);
    activeIdRef.current = id;
  }, []);

  const newConversation = useCallback((seed?: Partial<Conversation>) => {
    const conv: Conversation = { ...makeConv(), ...seed };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    activeIdRef.current = conv.id;
    return conv.id;
  }, []);

  // 群聊：创建 group 模式会话并激活（必须 ≥2 参与者，由 makeGroupConv 兜底校验）。
  // 群聊不对胶囊开放，仅主窗口「AI 对话」模块使用。
  const newGroup = useCallback((participantIds: string[], groupName?: string) => {
    let id = '';
    try {
      const conv = makeGroupConv(participantIds, groupName);
      id = conv.id;
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      activeIdRef.current = conv.id;
    } catch (e) {
      console.error('[useAiChat] 创建群聊失败', e);
    }
    return id;
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (id === activeIdRef.current) {
        // allowEmpty：删空后不再自动补一个保底会话，回到「没任务提示创建」
        const fallback = allowEmpty ? (next[0] ?? null) : (next[0] ?? makeConv());
        if (!allowEmpty && !next.length) next.push(fallback!);
        setActiveId(fallback?.id ?? '');
        activeIdRef.current = fallback?.id ?? '';
      }
      return next;
    });
  }, [allowEmpty]);

  // 对某条会话做不可变更新（自动 bump updatedAt）—— AIWork 统一任务回写蓝图用。
  const patchConv = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c)));
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: title.trim() || c.title } : c)));
  }, []);

  /** 改**当前会话**的思考档位覆盖（对话页那个档位选择器）。空串 = 清除覆盖、跟随配置。 */
  const setEffort = useCallback((v: string) => {
    const cid = activeIdRef.current;
    if (!cid) return;
    setConversations((prev) => prev.map((c) => (
      c.id === cid ? { ...c, effort: v.trim() || undefined } : c
    )));
  }, []);

  const clearAll = useCallback(() => {
    const fresh = makeConv();
    setConversations([fresh]);
    setActiveId(fresh.id);
    activeIdRef.current = fresh.id;
  }, []);

  const send = useCallback(async (text: string, images?: string[], attachments?: SendAttachment[]) => {
    const content = text.trim();
    const hasImages = !!images?.length;
    const atx: SendAttachment[] = attachments ?? [];
    if (!content && !hasImages && atx.length === 0) return;
    if (busyRef.current) return;
    const cid = activeIdRef.current;
    if (!cid) return;
    // 群聊会话：自动走串行多人发言调度（内部注入各伴侣人设）
    const conv = stateRef.current.conversations.find((c) => c.id === cid);
    if (conv?.mode === 'group' && (conv.participants?.length ?? 0) >= 2) {
      return groupSend(content || '（附件）');
    }

    const reqId = uid();
    reqRef.current = reqId;
    streamConvIdRef.current = cid;

    // 附件陈列元数据（仅名字/类型/大小，不落文本内容，避免撑爆 localStorage）
    const atxMeta: AttachmentMeta[] = atx.map(({ kind, name, mime, size }) => ({ kind, name, mime, size }));
    const userMsg: ChatMsg = {
      id: uid(), role: 'user', content: content || '（附件）', images,
      attachments: atxMeta.length ? atxMeta : undefined,
    };
    const asstId = uid();
    // traceId = 本次请求 id，同时是 agent 事件日志的落盘会话 id（ai_sessions/<id>.json）；
    // 消息上带此 id 后，「执行轨迹」面板才能关联到后端事件日志。
    const asstMsg: ChatMsg = { id: asstId, role: 'assistant', content: '', reasoning: '', traceId: reqId };

    let isFirst = true;
    setConversations((prev) => prev.map((c) => {
      if (c.id !== cid) return c;
      const messages = [...c.messages, userMsg, asstMsg];
      // 首条用户消息生成会话标题
      const title = c.title || c.messages.length === 0 ? genTitle(content) : c.title;
      return { ...c, messages, title, updatedAt: Date.now() };
    }));
    asstRef.current = asstId;
    busyRef.current = true;
    setBusy(true);
    void isFirst;

    const history = stateRef.current.conversations.find((c) => c.id === cid)?.messages ?? [];

    // 永久对话记忆：发送前检索 L3（namespace='ai-chat'），命中则注入 system 的语义记忆段。
    // 失败/未开启/无嵌入端点都静默降级，不影响正常对话。
    let ragContext = '';
    if (getAiChatMemoryEnabled()) {
      try {
        ragContext = await retrieveChatContext(content, 'ai-chat', 5);
      } catch { ragContext = ''; }
    }

    // 汇总 system（方案 B 优先级排序，人设永远最先）：
    //   [1] personaPrompt（人设画像，最稳定最高优先级）
    //   [2] systemPrompt（调用方指令，如 L2 core 档案）
    //   [3] ragContext（L3 检索到的长期对话记忆）
    const systemParts: string[] = [];
    if (personaPrompt) systemParts.push(personaPrompt);
    if (systemPrompt) systemParts.push(systemPrompt);
    if (ragContext) systemParts.push(ragContext);
    const finalSystem = systemParts.length ? systemParts.join('\n\n') : undefined;

    // 多模态·发图（对齐移动端阶段 5）：逐张调用 ai_vision_ocr 生成描述，追加到发给模型的 user 消息，
    // 让 AI「看见」图片（图片本体不发给后端，只发描述，兼容不支持视觉的模型）。失败静默标记不中断。
    let imageNote = '';
    if (hasImages) {
      for (let i = 0; i < images!.length; i++) {
        const img = images![i];
        const mime = img.startsWith('data:image/') ? img.slice(11, img.indexOf(';')) : 'image/png';
        const b64 = img.includes('base64,') ? img.split('base64,')[1] : img;
        try {
          const desc = await invoke<string>('ai_vision_ocr', {
            imageBase64: b64,
            imageMime: mime,
            prompt: `请用中文描述这张图片的内容（第 ${i + 1} 张，共 ${images!.length} 张）。如果包含文字请指出。50 字以内。`,
            profileId: profileIdRef.current,
          });
          imageNote += `\n[用户发来的图${i + 1}] ${desc}`;
        } catch {
          imageNote += `\n[用户发来的图${i + 1}] （图片理解失败）`;
        }
      }
    }

    // 附件·注入：text 附件把读取到的内容拼入发给模型的 user 消息；
    // file（二进制）仅写明文件名，内容不送（避免无效/超大 payload）。
    let attachNote = '';
    for (const a of atx) {
      if (a.kind === 'text' && a.text) {
        attachNote += `\n[用户上传的文件 ${a.name} 的内容]\n${a.text}`;
      } else if (a.kind === 'file') {
        attachNote += `\n[用户上传了文件 ${a.name}（${a.mime || '二进制'}，${a.size ?? ''} 字节；内容未读取）]`;
      }
    }

    const shouldInject = hasImages || attachNote.length > 0;
    const payload = {
      requestId: reqId,
      profileId: profileIdRef.current,
      // 请求前硬防御：真实 token 估算尾部截断 + 单条硬切（双保险，坐实重复拼接真因）
      // 最后一条 user 内容若带图/带附件，把 OCR 描述与文件内容拼接在原文后（本地显示保持原图/原文不变）。
      messages: safeMessages(
        history
          .concat([shouldInject ? { ...userMsg, content: content + imageNote + attachNote } : userMsg])
          .map((m) => ({ role: m.role, content: m.content })),
      ),
      stream: true,
      ...(finalSystem ? { system: finalSystem } : {}),
      ...(excludeGlobalPersona ? { exclude_global_persona: true } : {}),
      // 档位覆盖：读**这条会话**上存的（对话页选的）。留空不带该键 = 后端用配置。
      ...(conv?.effort?.trim() ? { effort: conv.effort.trim() } : {}),
    };

    // 本轮对话完成后（ai-done 事件），异步沉淀整轮进长期记忆（namespace='ai-chat'）。
    // 一次性 listen + 匹配 requestId，完成后立即 unlisten，避免监听器累积。
    if (getAiChatMemoryEnabled()) {
      let unlisten: (() => void) | null = null;
      const reg = listen<{ requestId: string }>('ai-done', (e) => {
        if (e.payload.requestId !== reqId) return;
        unlisten?.();
        // 从最新会话快照取 assistant 整轮文本（流式已写入 stateRef）
        const finalAsst = stateRef.current.conversations
          .find((c) => c.id === cid)?.messages.find((m) => m.id === asstId)?.content ?? '';
        void ingestChatTurn(content, finalAsst, 'ai-chat');
      });
      reg.then((u) => { unlisten = u; });
    }

    try {
      if (agentRef.current) {
        // Agent 工具模式：走 ai_chat_agent（后台 worker，非阻塞立即返回）。
        // 事件经 ai-agent-step/ai-done/ai-error 推送，useAiStream(prefix:'ai') 已兼容监听。
        // 媒体后端配置在前端解析（Rust 读不到 localStorage）：按「后端清单 + 路由表」
        // 为 image/vision/speech 各选一个后端，随机请求带入 media 参数。
        // 未配置的能力不带该键——Rust 工具会给出可自纠的「未配置」提示。
        const media = await resolveMediaConfig().catch(() => null);
        await invoke('ai_chat_agent', {
          requestId: reqId,
          messages: (payload as { messages: Array<{ role: string; content: string }> }).messages,
          profileId: profileIdRef.current || null,
          ...(finalSystem ? { system: finalSystem } : {}),
          // 轮数上限从设置读（不再是写死的 8）—— "自己搭 ComfyUI 工作流"这类链路天然要吃更多轮
          maxRounds: agentMaxRounds(),
          projectRoot: null,
          ...(media ? { media } : {}),
          // 本轮图片随请求带入：模型不直接持有 base64，由 analyze_image 工具按序号取用。
          // 只走参数通道、不进 messages —— 避免数 MB base64 落进会话日志与模型上下文。
          ...(hasImages && images ? { images } : {}),
          ...(conv?.effort?.trim() ? { effort: conv.effort.trim() } : {}),
        });
      } else {
        await invoke('ai_chat', payload);
      }
    } catch (err) {
      reqRef.current = null;
      asstRef.current = null;
      busyRef.current = false;
      setBusy(false);
      // 错误消息必须短小，绝不把上游完整 JSON 塞进 content（污染 history 永久回灌）。
      const raw = String(err);
      const short = /HTTP\s+\d+/.test(raw)
        ? `请求失败（${raw.match(/HTTP\s+\d+[^,}]*/)?.[0] || '上游错误'}）`
        : `请求失败：${raw.slice(0, 120)}`;
      updateMessages(cid, (prev) => prev.map((m) => (m.id === asstId ? { ...m, error: true, content: '⚠ ' + short } : m)));
    }
  }, [systemPrompt, updateMessages]);

  // 群聊发言：单个发言者（伴侣）基于给定历史说一句，注入其独立人设 system。
  // intro 为编排者（router）给的本轮台词引导（接梗/补刀/旁观提示），增强「活人感」。
  // 复用全局 {prefix:'ai'} 流式监听落盘（reqRef/asstRef/streamConvIdRef），
  // 另起一次性 listen 等待本轮 ai-done/ai-error 完成，供 groupSend 串行 await。
  const sendOne = useCallback(async (speakerId: string, history: ChatMsg[], intro?: string) => {
    const content = history[history.length - 1]?.content ?? '';
    if (!content || busyRef.current) return;
    const cid = activeIdRef.current;
    if (!cid) return;

    const companion = useCompanionStore.getState().collection.companions.find((c) => c.id === speakerId);
    if (!companion) return;
    const persona = buildPersonaContext(companion);
    // 人设为基底，编排提示作为内部语境引导追加其后（绝不暴露给用户）
    const system = intro && intro.trim()
      ? `${persona}\n\n【本轮对话引导·仅内部参考，不要提及这是指令】${intro.trim()}`
      : persona;

    const reqId = uid();
    reqRef.current = reqId;
    streamConvIdRef.current = cid;

    const asstId = uid();
    const asstMsg: ChatMsg = { id: asstId, role: 'assistant', content: '', reasoning: '', speakerId };

    setConversations((prev) => prev.map((c) => (c.id === cid ? { ...c, messages: [...c.messages, asstMsg], updatedAt: Date.now() } : c)));
    asstRef.current = asstId;
    busyRef.current = true;
    setBusy(true);

    // 等待本轮完成（与全局流式监听共存：全局负责写文本，此 Promise 仅用于串行调度）
    let resolveDone: () => void;
    let rejectDone: (e: unknown) => void;
    const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
    const unlis: Array<UnlistenFn> = [];
    unlis.push(await listen<{ requestId: string }>('ai-done', (e) => {
      if (e.payload.requestId !== reqId) return;
      cleanup(); resolveDone();
    }));
    unlis.push(await listen<{ requestId: string; error: string }>('ai-error', (e) => {
      if (e.payload.requestId !== reqId) return;
      cleanup(); rejectDone(new Error(e.payload.error));
    }));
    const cleanup = () => { unlis.forEach((u) => u()); };

    // 档位覆盖：与单聊同一口径 —— 读这条会话上存的档位。群聊里每个人用自己的 profile，
    // 但"这轮对话想多想少"是会话级的诉求，不该因为群聊就静默失效。
    const convEffort = stateRef.current.conversations.find((c) => c.id === cid)?.effort?.trim() ?? '';
    const payload = {
      requestId: reqId,
      // 群聊：每位伴侣按其绑定的 AI 档案（profile_id）选模型；未绑定则回落全局默认档案
      profileId: companion.profile_id || profileIdRef.current,
      ...(convEffort ? { effort: convEffort } : {}),
      // 请求前硬防御：真实 token 估算尾部截断 + 单条硬切（双保险，坐实重复拼接真因）
      messages: safeMessages(history.map((m) => ({ role: m.role, content: m.content }))),
      stream: true,
      system,
      // 伴侣发言 → 伴侣人设优先：排斥后端「模型级全局人设」（compose_persona_system）。
      // 否则该伴侣绑定 profile 的 persona_* 会与上面的伴侣人设双层叠加，
      // 本地小上下文模型被两套人设+引导塞爆 → 严重思考/无法输出/CPU 拉满（实测复现）。
      exclude_global_persona: true,
    };

    try {
      await invoke('ai_chat', payload);
      await done;
    } catch (err) {
      reqRef.current = null;
      asstRef.current = null;
      busyRef.current = false;
      setBusy(false);
      // 错误消息必须短小，绝不把上游完整 JSON 塞进 content（污染 history 永久回灌）。
      // 错误细节已通过 ai-error 事件+终端日志可见，会话里只保留可读的简短摘要。
      const raw = String(err);
      const short = /HTTP\s+\d+/.test(raw)
        ? `请求失败（${raw.match(/HTTP\s+\d+[^,}]*/)?.[0] || '上游错误'}）`
        : `请求失败：${raw.slice(0, 120)}`;
      updateMessages(cid, (prev) => prev.map((m) => (m.id === asstId ? { ...m, error: true, content: '⚠ ' + short } : m)));
    }
  }, [updateMessages]);

  // 一次性纯文本问答（不落盘到会话），用于群聊编排者（router）决策。
  // 复用 invoke('ai_chat') + 一次性 listen 累积 ai-delta / ai-done，返回完整文本。
  const askOnce = useCallback(async (system: string, userText: string): Promise<string> => {
    const reqId = uid();
    let acc = '';
    let resolveDone: (s: string) => void;
    let rejectDone: (e: unknown) => void;
    const done = new Promise<string>((res, rej) => { resolveDone = res; rejectDone = rej; });
    const unlis: Array<UnlistenFn> = [];
    unlis.push(await listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
      if (e.payload.requestId !== reqId) return;
      acc += e.payload.delta;
    }));
    unlis.push(await listen<{ requestId: string }>('ai-done', (e) => {
      if (e.payload.requestId !== reqId) return;
      cleanup(); resolveDone(acc);
    }));
    unlis.push(await listen<{ requestId: string; error: string }>('ai-error', (e) => {
      if (e.payload.requestId !== reqId) return;
      cleanup(); rejectDone(new Error(e.payload.error));
    }));
    const cleanup = () => { unlis.forEach((u) => u()); };
    try {
      await invoke('ai_chat', {
        requestId: reqId,
        profileId: profileIdRef.current,
        messages: [{ role: 'user', content: userText }],
        stream: true,
        system,
      });
      return await done;
    } catch (err) {
      cleanup();
      throw err;
    }
  }, []);

  // 群聊编排者：读成员人设 + 用户消息 + 最近上下文，产出本轮「发言编排」，
  // 让群聊有活人感（不机械轮流：有人接梗、有人旁观、顺序不固定）。
  // 返回 { order: string[], intros: Record<string,string> }；解析失败返回 null（回落固定顺序）。
  interface GroupPlan { order: string[]; intros: Record<string, string>; }
  const planGroupRound = useCallback(async (
    participants: Array<{ id: string; name: string; description?: string | null }>,
    userText: string,
    recentSummary: string,
  ): Promise<GroupPlan | null> => {
    const roster = participants
      .map((p, i) => `${i + 1}. id=${p.id} 名字=${p.name} 简介=${p.description || '无简介'}`)
      .join('\n');
    const maxSpeakers = Math.min(participants.length, 4);
    const system = `你是这群 AI 伴侣的「群聊编排者」。用户刚说了一句话，你要决定这一轮群里谁该开口、以什么基调说，让对话像真实朋友群聊一样有「活人感」。
原则：
- 不必所有人发言；可以有人旁观、沉默、只发表情式短句——更有真实感。
- 顺序不要固定，可以有人抢话、有人后补、有人只接上一句的话。
- 允许接梗、补刀、反问、温和调侃、共鸣、跑题一点点。
- 输出严格 JSON，不要任何解释或 markdown 代码块，格式：
{"order":["id1","id2"],"intros":{"id1":"给这位的台词引导，例如：先接用户的梗，带点调侃","id2":"顺着前一位的话补一句，别太冲"}}
- order 里的 id 必须来自下面的名单；长度 1~${maxSpeakers}；顺序即发言顺序。
- 名单：\n${roster}
- 最近群聊上下文：\n${recentSummary}`;
    try {
      const raw = await askOnce(system, `用户说：「${userText}」\n请只输出本轮发言编排 JSON。`);
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      const parsed = JSON.parse(raw.slice(start, end + 1)) as GroupPlan;
      if (Array.isArray(parsed.order) && parsed.order.length > 0) return parsed;
      return null;
    } catch {
      return null;
    }
  }, [askOnce]);

  // 群聊发送：用户一句 → 编排者决定本轮谁说、按什么基调 → 串行上屏（活人感）。
  // 不暴露 severity/cost，仅内部累加 groupCost.calls 供信息条展示「本次已调用 N 次 AI」。
  const groupSend = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || busyRef.current) return;
    const cid = activeIdRef.current;
    if (!cid) return;
    const conv = stateRef.current.conversations.find((c) => c.id === cid);
    if (!conv || conv.mode !== 'group' || !conv.participants?.length) return;

    const userMsg: ChatMsg = { id: uid(), role: 'user', content, speakerId: 'user' };
    setConversations((prev) => prev.map((c) => {
      if (c.id !== cid) return c;
      const messages = [...c.messages, userMsg];
      const title = c.title || genTitle(content);
      return { ...c, messages, title, updatedAt: Date.now() };
    }));

    // 取参与者伴侣对象（用于编排者名单）
    const allCompanions = useCompanionStore.getState().collection.companions;
    const participants = (conv.participants ?? [])
      .map((id) => allCompanions.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c);

    // 最近上下文摘要（最多 6 条，截断内容），供编排者判断氛围
    const recent = stateRef.current.conversations
      .find((c) => c.id === cid)?.messages.slice(-6)
      .map((m) => {
        const who = m.speakerId === 'user' ? '用户' : (allCompanions.find((c) => c.id === m.speakerId)?.name ?? '某人');
        const txt = (m.content || '').slice(0, 60);
        return `- ${who}: ${txt}`;
      }).join('\n') ?? '';

    let calls = 0;
    // 编排者决策本轮发言序列（有人可能沉默，顺序不固定）
    const plan = await planGroupRound(participants, content, recent);
    calls += plan ? 1 : 0;
    const order = plan?.order?.filter((id) => participants.some((p) => p.id === id)) ?? conv.participants;

    for (const speakerId of order) {
      // 每轮发言前取最新会话快照作为历史（含用户句 + 此前所有 AI 回复）
      const latest = stateRef.current.conversations.find((c) => c.id === cid);
      if (!latest) break;
      const history = latest.messages.filter((m) => !(m.role === 'assistant' && m.id === ''));
      await sendOne(speakerId, history, plan?.intros?.[speakerId]);
      calls += 1;
    }

    if (calls > 0) {
      setConversations((prev) => prev.map((c) => (c.id === cid ? { ...c, groupCost: { calls: (c.groupCost?.calls ?? 0) + calls }, updatedAt: Date.now() } : c)));
    }
  }, [sendOne, planGroupRound]);

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;
  const activeConvEffort = activeConv?.effort?.trim() ?? '';

  return {
    conversations,
    activeId,
    activeConv,
    busy,
    ready,
    profileId,
    agent: agentOn,
    setAgent,
    selectConv,
    newConversation,
    newGroup,
    deleteConversation,
    renameConversation,
    patchConv,
    effort: activeConvEffort,
    setEffort,
    clearAll,
    send,
    /** 停止本轮生成（点「停止」时调用）。已收到部分保留，并补「（已停止）」标记。 */
    abort,
    groupSend,
    sendOne,
  };
}
