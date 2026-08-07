// 黄金棋盘浮岛 · AI 对话子面板（从 Capsule.tsx 拆出）。
// 自持多会话 state + 流式监听（ai-delta/ai-done/ai-error/ai-reasoning-delta），仅与壳共享
// aiProfileId / aiHint / keepOpen（经 capsuleStore）。壳仅在 expanded && chatOpen && panelReady 时挂载。
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/lib/i18n';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { ThinkingToggle } from '@/core/ai/ThinkingToggle';
import { KeepButton } from '@/components/KeepButton';
import { useAiStream } from './useAiStream';
import { btnBase } from './constants';
import { IconNote, IconClose, IconSend } from './icons';
import type { Conversation, ChatMsg } from './types';
import { EVENTS } from '@/core/events/schema';

const CHAT_STORE_KEY = 'andeyunhui.capsule.conversations';
const CONV_TITLE_MAX = 20;

function loadConvs(): Conversation[] {
  try {
    const raw = localStorage.getItem(CHAT_STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Conversation[];
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch { /* 解析失败忽略 */ }
  return [];
}

function CapsuleChat({ coverUrl }: { coverUrl: string | null }) {
  const { t } = useI18n();
  // 共享状态（订阅切片）：模型档案 / 提示 / 保持态
  const aiProfileId = useCapsuleStore((s) => s.aiProfileId);
  const aiHint = useCapsuleStore((s) => s.aiHint);
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setChatOpen = useCapsuleStore((s) => s.setChatOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  const ensureProfiles = useCapsuleStore((s) => s.ensureProfiles);

  // 本地多会话 state
  const initialConvs = useMemo<Conversation[]>(() => {
    const cs = loadConvs();
    return cs.length ? cs : [{ id: 'c' + Date.now().toString(36), title: '新对话', messages: [], updatedAt: Date.now() }];
  }, []);
  const [conversations, setConversations] = useState<Conversation[]>(initialConvs);
  const [activeConvId, setActiveConvId] = useState<string>(() => initialConvs[0].id);
  const activeConvIdRef = useRef<string>(activeConvId);
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);
  // 持久化会话（localStorage，随胶囊 webview 持久，重启不丢）
  useEffect(() => {
    try { localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(conversations)); } catch { /* 忽略 */ }
  }, [conversations]);
  // 流式写入目标会话（发送时锁定，避免切会话后回写错位）
  const streamConvIdRef = useRef<string>(activeConvId);
  const updateStreamMessages = useCallback((convId: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, messages: updater(c.messages), updatedAt: Date.now() } : c)));
  }, []);
  // 当前会话消息（派生）
  const activeConv = conversations.find((c) => c.id === activeConvId);
  const chat = activeConv?.messages ?? [];

  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const activeReqRef = useRef<string | null>(null);
  const asstIdRef = useRef<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const newConversation = useCallback(() => {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    setConversations((prev) => [{ id, title: '新对话', messages: [], updatedAt: Date.now() }, ...prev]);
    setActiveConvId(id);
    setChatInput('');
    setChatBusy(false);
    activeReqRef.current = null;
    asstIdRef.current = null;
    streamConvIdRef.current = id;
  }, []);
  const selectConversation = useCallback((id: string) => {
    setActiveConvId(id);
    setChatInput('');
    setChatBusy(false);
    activeReqRef.current = null;
    asstIdRef.current = null;
  }, []);

  // 挂载即加载模型档案（壳仅在 chatOpen 时挂载本组件，故等价于原 [chatOpen] effect）
  useEffect(() => { ensureProfiles(); }, [ensureProfiles]);

  // 全局流式事件监听（ai-delta / ai-done / ai-error / ai-reasoning-delta），统一抽到 useAiStream
  useAiStream(
    { prefix: EVENTS.chatStream.prefix, deltaMode: 'append', hasReasoning: true },
    { reqRef: activeReqRef, asstRef: asstIdRef, streamConvIdRef, updateMessages: updateStreamMessages, setBusy: setChatBusy },
  );

  // 自动滚动对话到底部（打开面板 / 切换对话 / 流式增量时均滚到底）
  const scrollChatToBottom = () => { const el = chatScrollRef.current; if (el) el.scrollTop = el.scrollHeight; };
  useLayoutEffect(() => {
    scrollChatToBottom();
    const id = requestAnimationFrame(scrollChatToBottom); // 兜底：窗口 36→470 过渡重排后再滚一次
    return () => cancelAnimationFrame(id);
  }, [chat]);

  // 发送 AI 消息（复用全局 ai_chat，流式回传经全局事件）
  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    if (!aiProfileId) {
      useCapsuleStore.getState().setAiHint(t('capsule.noModelHint'));
      return;
    }
    const uid = 'u' + Date.now().toString(36);
    const aid = 'a' + Date.now().toString(36);
    const convId = activeConvId; // 发送时锁定目标会话
    streamConvIdRef.current = convId;
    const history = chat.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    const payload = [
      { role: 'system', content: '你是一个 helpful 的 AI 助手，请用简体中文回答；必要时用 ``` 代码块给出示例并简述要点。' },
      ...history,
      { role: 'user', content: text },
    ];
    // 首条消息用内容自动命名会话（标题为空 / 默认「新对话」时）
    updateStreamMessages(convId, (prev) => [...prev, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '' }]);
    setConversations((prev) => prev.map((c) => (c.id === convId && (c.title === '新对话' || !c.title.trim())) ? { ...c, title: text.slice(0, CONV_TITLE_MAX) } : c));
    setChatInput('');
    setChatBusy(true);
    const reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    activeReqRef.current = reqId;
    asstIdRef.current = aid;
    try {
      await invoke('ai_chat', { requestId: reqId, messages: payload, profileId: aiProfileId });
    } catch (e) {
      if (activeReqRef.current === reqId) {
        setChatBusy(false);
        activeReqRef.current = null;
        updateStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: '⚠ ' + String(e) } : m)));
        asstIdRef.current = null;
      }
    }
  }, [chatInput, chatBusy, aiProfileId, chat, t, updateStreamMessages]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px' }} onClick={(e) => e.stopPropagation()}>
      {/* 顶部细条：小封面 + 标题 + 播放切换 + 关闭对话 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 9,
            flex: '0 0 40px',
            background: 'rgba(255,255,255,0.06)',
            backgroundImage: coverUrl ? `url(${coverUrl})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#e6c35c',
            overflow: 'hidden',
          }}
        >
          {!coverUrl && <IconNote />}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select
              value={activeConvId}
              onChange={(e) => selectConversation(e.target.value)}
              title={t('capsule.selectConv')}
              style={{
                flex: 1, minWidth: 0,
                fontSize: 12.5, color: '#f6f6f8',
                background: 'rgba(0,0,0,0.28)',
                border: '1px solid rgba(255,255,255,0.16)',
                borderRadius: 8, padding: '5px 6px',
                outline: 'none',
              }}
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id} style={{ background: '#1c1c1e', color: '#f6f6f8' }}>
                  {(c.title || t('capsule.newConvLabel')).slice(0, CONV_TITLE_MAX)}
                </option>
              ))}
            </select>
            <button onClick={newConversation} title={t('capsule.newConv')} style={{ ...btnBase, width: 30, height: 30, flex: '0 0 auto', color: '#e6c35c', background: 'rgba(230,195,92,0.14)', fontSize: 18, lineHeight: 1 }}>
              +
            </button>
          </div>
          <div style={{ fontSize: 10.5, color: 'rgba(244,244,246,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {conversations.length} 个对话 · 全局 AI · 复用模型配置
          </div>
        </div>
        <KeepButton pinned={keepOpen} onToggle={() => setKeepOpen(!keepOpen)} size={28} />
        <button onClick={() => setChatOpen(false)} title={t('capsule.backToPlayer')} style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto' }}>
          <IconClose />
        </button>
      </div>

      {/* 消息列表 */}
      <div ref={chatScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
        {aiHint && (
          <div style={{ fontSize: 12, color: 'rgba(230,195,92,0.9)', background: 'rgba(230,195,92,0.1)', borderRadius: 8, padding: '8px 10px' }}>{aiHint}</div>
        )}
        {!aiHint && chat.length === 0 && (
          <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>{t('capsule.chatHint')}</div>
        )}
        {chat.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              background: m.role === 'user' ? 'rgba(230,195,92,0.18)' : 'rgba(255,255,255,0.08)',
              color: m.error ? '#ff9a9a' : '#f2f2f4',
              borderRadius: 12,
              padding: '8px 10px',
              fontSize: 12.5,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {/* 思考过程：可折叠、遮罩小字（仅助手消息有 reasoning 时显示） */}
            {m.role === 'assistant' && m.reasoning ? (
              <div style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setReasoningOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
                  style={{
                    ...btnBase, padding: '1px 7px', fontSize: 10.5, borderRadius: 6,
                    background: 'rgba(255,255,255,0.07)', color: 'rgba(244,244,246,0.62)', marginBottom: 4,
                  }}
                >
                  {reasoningOpen[m.id] ? '▾' : '▸'} {t('capsule.reasoning')}{reasoningOpen[m.id] ? '' : `（${m.reasoning.length} ${t('capsule.chars')} · ${t('capsule.clickExpand')}）`}
                </button>
                {reasoningOpen[m.id] && (
                  <div style={{
                    fontSize: 10.5, lineHeight: 1.55, fontStyle: 'italic',
                    color: 'rgba(244,244,246,0.5)', background: 'rgba(0,0,0,0.2)',
                    borderRadius: 8, padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    filter: 'blur(0.3px)',
                  }}>
                    {m.reasoning}
                  </div>
                )}
              </div>
            ) : null}
            {m.content || (m.role === 'assistant' && chatBusy ? t('capsule.thinking') : '')}
          </div>
        ))}
      </div>

      {/* 输入区：统一舒展输入框，思考开关与发送按钮被囊括在同一容器内 */}
      <div style={{ marginTop: 8, borderRadius: 12, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.22)', padding: 8 }}>
        <textarea
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault();
              void sendChat();
            }
          }}
          rows={1}
          placeholder={aiProfileId ? t('capsule.inputMsg') : t('capsule.noModel')}
          disabled={!aiProfileId}
          style={{
            width: '100%',
            display: 'block',
            resize: 'none',
            maxHeight: 90,
            minHeight: 34,
            height: 34,
            border: 'none',
            background: 'transparent',
            color: '#f4f4f6',
            padding: '4px 4px',
            fontSize: 12.5,
            lineHeight: 1.4,
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <ThinkingToggle profileId={aiProfileId} compact disabled={!aiProfileId} />
          <button
            onClick={() => void sendChat()}
            disabled={chatBusy || !aiProfileId || !chatInput.trim()}
            title={t('capsule.send')}
            style={{ ...btnBase, width: 34, height: 34, background: 'rgba(230,195,92,0.18)', opacity: chatBusy || !aiProfileId || !chatInput.trim() ? 0.45 : 1 }}
          >
            <IconSend />
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(CapsuleChat);
