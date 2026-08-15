// AI 对话核心逻辑 Hook —— 胶囊浮窗与独立「AI 对话」模块共用的纯逻辑层。
// 不渲染任何 UI：管理多会话 state、localStorage 持久化、流式事件接线、发送。
// UI 由调用方自行设计（浮窗用紧凑版 AiChatPanel，主窗口用双栏 AiChatConversation + AiChatSidebar）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMsg, Conversation } from '@/components/capsule/types';
import { useAiStream } from '@/components/capsule/useAiStream';
import { EVENTS } from '@/core/events/schema';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { uid, persistConversations, loadConversations, genTitle, makeConv, mergeConversations, AI_CHAT_CONVERSATIONS_KEY } from '@/components/ai-chat/util';

export const DEFAULT_PERSIST_KEY = AI_CHAT_CONVERSATIONS_KEY;
const SYNC_EVENT = 'ai-chat:conversations-sync';
const SYNC_REQ_EVENT = 'ai-chat:conversations-request';

export interface UseAiChatOptions {
  /** localStorage 持久化键，不同入口用不同键避免串号（胶囊 / AI 对话模块 / 其他浮窗） */
  persistKey?: string;
  /** 注入的 system 指令（可选，留空则用后端默认） */
  systemPrompt?: string;
}

export interface UseAiChatResult {
  conversations: Conversation[];
  activeId: string;
  activeConv: Conversation | null;
  busy: boolean;
  ready: boolean;
  profileId: string;
  selectConv: (id: string) => void;
  newConversation: () => string;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  clearAll: () => void;
  send: (text: string) => Promise<void>;
}

/**
 * 共用 AI 对话逻辑。状态、持久化、流式、发送全在此，调用方只负责把数据画出来。
 */
export function useAiChat(options: UseAiChatOptions = {}): UseAiChatResult {
  const { persistKey = DEFAULT_PERSIST_KEY, systemPrompt } = options;

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
  useAiStream(
    { prefix: EVENTS.chatStream.prefix, deltaMode: 'append', hasReasoning: true },
    { reqRef, asstRef, streamConvIdRef, updateMessages, setBusy: (v) => { busyRef.current = v; setBusy(v); } },
  );

  // 取当前激活 AI 档案 id（沙箱内 zustand store 隔离，故走 invoke）
  const loadProfile = useCallback(async () => {
    try {
      const data = await invoke<{ profiles: Array<{ id: string; enabled?: boolean }> }>('ai_get_profiles');
      const list = Array.isArray(data?.profiles) ? data.profiles : [];
      const active = list.find((p) => p.enabled) ?? list[0];
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
    let initial: Conversation[];
    if (loaded.length) {
      initial = loaded;
    } else {
      initial = [makeConv()];
    }
    setConversations(initial);
    setActiveId(initial[0].id);
    activeIdRef.current = initial[0].id;
    void loadProfile().finally(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey]);

  // 持久化（会话变化即写本地）；且向其它窗口广播合并（应用远端时不重复广播）
  useEffect(() => {
    if (!ready) return;
    persistConversations(persistKey, conversations);
    if (!applyingRemote.current) {
      void emit(SYNC_EVENT, { src: myLabel, conversations }).catch(() => {});
    }
  }, [conversations, persistKey, ready, myLabel]);

  // 监听其它窗口的会话变更，合并进本地（不覆盖对端独有历史）
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let unReq: UnlistenFn | undefined;
    listen<{ src: string; conversations: Conversation[] }>(SYNC_EVENT, (e) => {
      if (e.payload.src === myLabel) return;
      applyingRemote.current = true;
      setConversations((local) => mergeConversations(local, e.payload.conversations));
      setTimeout(() => { applyingRemote.current = false; }, 0);
    }).then((u) => { un = u; });
    // 收到拉取请求 → 回复本端全量（让对端获得已有历史，解决"打开即同步"）
    listen<{ src: string }>(SYNC_REQ_EVENT, (e) => {
      if (e.payload.src === myLabel) return;
      if (applyingRemote.current) return;
      const snapshot = stateRef.current.conversations;
      if (!snapshot.length) return;
      void emit(SYNC_EVENT, { src: myLabel, conversations: snapshot }).catch(() => {});
    }).then((u) => { unReq = u; });
    return () => { un?.(); unReq?.(); };
  }, [myLabel]);

  // 挂载时主动拉取另一端已有历史（胶囊与主窗口独立 webview，localStorage 隔离）
  useEffect(() => {
    void emit(SYNC_REQ_EVENT, { src: myLabel }).catch(() => {});
  }, [myLabel]);

  const selectConv = useCallback((id: string) => {
    setActiveId(id);
    activeIdRef.current = id;
  }, []);

  const newConversation = useCallback(() => {
    const conv = makeConv();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    activeIdRef.current = conv.id;
    return conv.id;
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (id === activeIdRef.current) {
        const fallback = next[0] ?? makeConv();
        if (!next.length) next.push(fallback);
        setActiveId(fallback.id);
        activeIdRef.current = fallback.id;
      }
      return next;
    });
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: title.trim() || c.title } : c)));
  }, []);

  const clearAll = useCallback(() => {
    const fresh = makeConv();
    setConversations([fresh]);
    setActiveId(fresh.id);
    activeIdRef.current = fresh.id;
  }, []);

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || busyRef.current) return;
    const cid = activeIdRef.current;
    if (!cid) return;

    const reqId = uid();
    reqRef.current = reqId;
    streamConvIdRef.current = cid;

    const userMsg: ChatMsg = { id: uid(), role: 'user', content };
    const asstId = uid();
    const asstMsg: ChatMsg = { id: asstId, role: 'assistant', content: '', reasoning: '' };

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
    const payload = {
      requestId: reqId,
      profileId: profileIdRef.current,
      messages: history.concat([userMsg]).map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      ...(systemPrompt ? { system: systemPrompt } : {}),
    };
    try {
      await invoke('ai_chat', payload);
    } catch (err) {
      reqRef.current = null;
      asstRef.current = null;
      busyRef.current = false;
      setBusy(false);
      updateMessages(cid, (prev) => prev.map((m) => (m.id === asstId ? { ...m, error: true, content: '⚠ ' + String(err) } : m)));
    }
  }, [systemPrompt, updateMessages]);

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;

  return {
    conversations,
    activeId,
    activeConv,
    busy,
    ready,
    profileId,
    selectConv,
    newConversation,
    deleteConversation,
    renameConversation,
    clearAll,
    send,
  };
}
