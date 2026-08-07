// 黄金棋盘浮岛 · AI 编程子面板（从 Capsule.tsx 拆出）。
// 接管 IDE 对话执行（chat / agent 双模式），经 capsule-ide-chat-* / capsule-ide-agent-* 事件桥接。
// 自持多会话 state + 流式监听，仅与壳共享 aiProfiles / aideProfileId / aiHint / keepOpen（经 capsuleStore）。
// 壳仅在 expanded && aideOpen && panelReady 时挂载。
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { useI18n } from '@/lib/i18n';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { ThinkingToggle } from '@/core/ai/ThinkingToggle';
import { KeepButton } from '@/components/KeepButton';
import { useAiStream } from './useAiStream';
import { btnBase, GOLD } from './constants';
import { IconClose, IconSend } from './icons';
import type { Conversation, ChatMsg } from './types';
import { EVENTS } from '@/core/events/schema';

const AIDE_STORE_KEY = 'andeyunhui.capsule.aide.conversations.v2'; // 升版本清空历史浮岛 AI 编程对话（与 IDE 对齐）
const CONV_TITLE_MAX = 20;

// 清洗发给 IDE 的历史：丢弃空助手占位 / 连续重复消息 / 超长截断，阻断退化乱码被反复回灌形成循环
function cleanAideHistory(msgs: Array<{ role?: string; content?: unknown }>): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const m of msgs) {
    if (!m || !m.role || m.content == null) continue;
    const c = String(m.content);
    if (m.role === 'assistant' && c.trim() === '') continue; // 跳过空助手（残留占位）
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && prev.content === c) continue; // 去重连续相同
    out.push({ role: m.role as string, content: c });
  }
  return out.slice(-24);
}

function CapsuleAide() {
  const { t } = useI18n();
  // 共享状态（订阅切片）
  const aiProfiles = useCapsuleStore((s) => s.aiProfiles);
  const aideProfileId = useCapsuleStore((s) => s.aideProfileId);
  const aiHint = useCapsuleStore((s) => s.aiHint);
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setAideOpen = useCapsuleStore((s) => s.setAideOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  const setAideProfileId = useCapsuleStore((s) => s.setAideProfileId);
  const setAiHint = useCapsuleStore((s) => s.setAiHint);
  const ensureProfiles = useCapsuleStore((s) => s.ensureProfiles);

  const configuredAideProfiles = aiProfiles.filter((p) => p.api_key && p.api_key.trim());

  // 本地多对话 state
  const initialAideConvs = useMemo(() => {
    try {
      const raw = localStorage.getItem(AIDE_STORE_KEY);
      if (raw) {
        const cs = JSON.parse(raw) as Conversation[];
        if (Array.isArray(cs) && cs.length) return cs;
      }
    } catch { /* 忽略 */ }
    return [{ id: 'ac' + Date.now().toString(36), title: '新对话', messages: [], updatedAt: Date.now() }];
  }, []);
  const [aideConversations, setAideConversations] = useState<Conversation[]>(initialAideConvs);
  const [aideActiveConvId, setAideActiveConvId] = useState<string>(initialAideConvs[0].id);
  const aideActiveConvIdRef = useRef<string>(aideActiveConvId);
  useEffect(() => { aideActiveConvIdRef.current = aideActiveConvId; }, [aideActiveConvId]);
  useEffect(() => { try { localStorage.setItem(AIDE_STORE_KEY, JSON.stringify(aideConversations)); } catch { /* 忽略 */ } }, [aideConversations]);
  const aideStreamConvIdRef = useRef<string>(aideActiveConvId);
  const updateAideStreamMessages = useCallback((convId: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    setAideConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, messages: updater(c.messages), updatedAt: Date.now() } : c)));
  }, []);
  const aideActiveConv = aideConversations.find((c) => c.id === aideActiveConvId);
  const aideMessages = aideActiveConv?.messages ?? [];

  const [aideInput, setAideInput] = useState('');
  const [aideBusy, setAideBusy] = useState(false);
  const [aideReasoningOpen, setAideReasoningOpen] = useState<Record<string, boolean>>({});
  const aideReqRef = useRef<string | null>(null);
  const aideAsstRef = useRef<string | null>(null);
  const aideScrollRef = useRef<HTMLDivElement | null>(null);
  const [aideMode, setAideMode] = useState<'chat' | 'agent'>('chat'); // AI 编程：对话 / 代理（agent）

  // 清空全部对话（浮岛 AI 编程 + 通知 IDE 一并清空 chat/agent），一键回到干净起点
  const clearAideConversations = useCallback(() => {
    const fresh: Conversation[] = [{ id: 'ac' + Date.now().toString(36), title: '新对话', messages: [], updatedAt: Date.now() }];
    setAideConversations(fresh);
    setAideActiveConvId(fresh[0].id);
    aideActiveConvIdRef.current = fresh[0].id;
    aideStreamConvIdRef.current = fresh[0].id;
    try { localStorage.removeItem(AIDE_STORE_KEY); } catch { /* 忽略 */ }
    emit(EVENTS.chatStream.clearConversations).catch(() => {});
  }, []);
  const newAideConversation = useCallback(() => {
    const id = 'ac' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    setAideConversations((prev) => [{ id, title: '新对话', messages: [], updatedAt: Date.now() }, ...prev]);
    setAideActiveConvId(id);
    setAideInput('');
    setAideBusy(false);
    aideReqRef.current = null;
    aideAsstRef.current = null;
    aideStreamConvIdRef.current = id;
  }, []);
  const selectAideConversation = useCallback((id: string) => {
    setAideActiveConvId(id);
    setAideInput('');
    setAideBusy(false);
    aideReqRef.current = null;
    aideAsstRef.current = null;
  }, []);

  // 挂载即加载模型档案 + 反向同步 IDE 当前对话（壳仅在 aideOpen 时挂载本组件）
  useEffect(() => {
    ensureProfiles();
    invoke<{ conversations?: Array<Conversation>; active_id?: string | null }>('ai_get_conversations')
      .then((d) => {
        const list = (d?.conversations || []).filter((c) => c && Array.isArray(c.messages));
        if (!list.length) return;
        setAideConversations(list);
        const aid = (d.active_id && list.some((c) => c.id === d.active_id)) ? d.active_id! : list[0].id;
        setAideActiveConvId(aid);
        aideActiveConvIdRef.current = aid;
      })
      .catch(() => {});
  }, [ensureProfiles]);

  // 跟随 IDE 当前激活模型：IDE 切换模型时广播，浮岛 AI 编程用同一模型
  useEffect(() => {
    let unsub: (() => void) | undefined;
    listen<{ id: string }>(EVENTS.ai.activeProfileChanged, (e) => {
      const id = e?.payload?.id;
      if (id) setAideProfileId(id);
    }).then((u) => { unsub = u; });
    return () => unsub?.();
  }, [setAideProfileId]);

  // 浮岛「AI 编程」流式事件监听（chat / agent 双模式），统一抽到 useAiStream
  // chat 模式：delta 追加 + reasoning；agent 模式：text 整段替换、无 reasoning
  useAiStream(
    { prefix: EVENTS.chatStream.ideChatPrefix, deltaMode: 'append', hasReasoning: true },
    { reqRef: aideReqRef, asstRef: aideAsstRef, streamConvIdRef: aideStreamConvIdRef, updateMessages: updateAideStreamMessages, setBusy: setAideBusy },
  );
  useAiStream(
    { prefix: EVENTS.chatStream.ideAgentPrefix, deltaMode: 'replace', hasReasoning: false },
    { reqRef: aideReqRef, asstRef: aideAsstRef, streamConvIdRef: aideStreamConvIdRef, updateMessages: updateAideStreamMessages, setBusy: setAideBusy },
  );

  // 自动滚动到底部
  const scrollAideToBottom = () => { const el = aideScrollRef.current; if (el) el.scrollTop = el.scrollHeight; };
  useLayoutEffect(() => {
    scrollAideToBottom();
    const id = requestAnimationFrame(scrollAideToBottom);
    return () => cancelAnimationFrame(id);
  }, [aideMessages, aideActiveConvId]);

  // 浮岛「AI 编程」发送：不调 ai_chat，通知 IDE 接管对话（chat 模式，事件桥接，携带 profile + 历史）
  const sendAide = useCallback(async () => {
    const text = aideInput.trim();
    if (!text || aideBusy) return;
    // agent（自主编辑）模式：转发给 IDE 的 agent 面板执行，使用 IDE 当前激活档案（无需浮岛侧 profile）
    if (aideMode === 'agent') {
      if (aideReqRef.current) return; // 同步防重入：已有请求在飞时忽略
      const uid = 'u' + Date.now().toString(36);
      const aid = 'a' + Date.now().toString(36);
      const convId = aideActiveConvId;
      aideStreamConvIdRef.current = convId;
      const history = cleanAideHistory(aideMessages.filter((m) => !m.error));
      const reqId = 'cage_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      updateAideStreamMessages(convId, (prev) => [...prev, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '' }]);
      setAideConversations((prev) => prev.map((c) => (c.id === convId && (c.title === '新对话' || !c.title.trim())) ? { ...c, title: text.slice(0, CONV_TITLE_MAX) } : c));
      setAideInput('');
      setAideBusy(true);
      aideReqRef.current = reqId;
      aideAsstRef.current = aid;
      const timer = setTimeout(() => {
        if (aideReqRef.current === reqId) {
          aideReqRef.current = null;
          aideAsstRef.current = null;
          updateAideStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: (m.content ? m.content + '\n\n' : '') + '⚠ IDE 未响应：请确认 IDE 模块已加载且处于「自主编辑（agent）模式」并已打开 AI 面板。' } : m)));
          setAideBusy(false);
        }
      }, 20000);
      try {
        await emit(EVENTS.chatStream.agentRequest, { requestId: reqId, text, profileId: aideProfileId ?? undefined, history });
      } catch (e) {
        clearTimeout(timer);
        aideReqRef.current = null;
        aideAsstRef.current = null;
        updateAideStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: '⚠ 发送失败：' + String(e) } : m)));
        setAideBusy(false);
      }
      return;
    }
    if (!aideProfileId) {
      setAiHint(t('capsule.noModelHint'));
      return;
    }
    const uid = 'u' + Date.now().toString(36);
    const aid = 'a' + Date.now().toString(36);
    const convId = aideActiveConvId;
    aideStreamConvIdRef.current = convId;
    const history = cleanAideHistory(aideMessages.filter((m) => !m.error));
    const reqId = 'cide_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    updateAideStreamMessages(convId, (prev) => [...prev, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '' }]);
    setAideConversations((prev) => prev.map((c) => (c.id === convId && (c.title === '新对话' || !c.title.trim())) ? { ...c, title: text.slice(0, CONV_TITLE_MAX) } : c));
    setAideInput('');
    setAideBusy(true);
    aideReqRef.current = reqId;
    aideAsstRef.current = aid;
    // 兜底：若 IDE 未响应，避免一直「思考中…」
    const timer = setTimeout(() => {
      if (aideReqRef.current === reqId) {
        aideReqRef.current = null;
        aideAsstRef.current = null;
        updateAideStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: (m.content ? m.content + '\n\n' : '') + '⚠ IDE 未响应：请确认 IDE 模块已加载且处于「对话模式」（非 agent 模式）。' } : m)));
        setAideBusy(false);
      }
    }, 20000);
    try {
      await emit(EVENTS.chatStream.chatRequest, { requestId: reqId, text, profileId: aideProfileId, history });
    } catch (e) {
      clearTimeout(timer);
      aideReqRef.current = null;
      aideAsstRef.current = null;
      updateAideStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: '⚠ 发送失败：' + String(e) } : m)));
      setAideBusy(false);
    }
  }, [aideInput, aideBusy, aideProfileId, aideMessages, aideMode, t, updateAideStreamMessages, setAiHint]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px' }} onClick={(e) => e.stopPropagation()}>
      {/* 顶部细条：返回 + 标题 + 对话切换 + 新建 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#f2f2f4' }}>{t('capsule.aideTitle')}</span>
        {/* 对话切换：下拉选择 / 新建 */}
        <select
          value={aideActiveConvId}
          onChange={(e) => selectAideConversation(e.target.value)}
          title={t('capsule.selectConv')}
          style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#f6f6f8', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 6px', outline: 'none' }}
        >
          {aideConversations.map((c) => (
            <option key={c.id} value={c.id} style={{ background: '#1c1c1e', color: '#f6f6f8' }}>
              {(c.title || t('capsule.newConvLabel')).slice(0, CONV_TITLE_MAX)}
            </option>
          ))}
        </select>
        <button onClick={newAideConversation} title={t('capsule.newConv')} style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto', color: GOLD, background: 'rgba(230,195,92,0.14)', fontSize: 16, lineHeight: 1 }}>
          +
        </button>
        <button onClick={() => clearAideConversations()} title={t('capsule.clearAllConvs')} style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto', color: 'rgba(244,244,246,0.8)', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', fontSize: 11 }}>
          {t('capsule.clear')}
        </button>
        <KeepButton pinned={keepOpen} onToggle={() => setKeepOpen(!keepOpen)} size={28} />
        <button onClick={() => setAideOpen(false)} title={t('capsule.backToPlayer')} style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto' }}>
          <IconClose />
        </button>
      </div>
      {/* 第二行：模式切换（对话 / 代理）+ 模型下拉 + 思考开关 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        {/* 模式切换：对话 = chat 桥；代理 = agent 桥（走 IDE 自主编辑面板） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: 2, flex: '0 0 auto' }}>
          <button onClick={() => setAideMode('chat')} title={t('capsule.modeChatTitle')} style={{ ...btnBase, padding: '3px 9px', fontSize: 11, borderRadius: 6, color: aideMode === 'chat' ? '#1c1c1e' : 'rgba(244,244,246,0.8)', background: aideMode === 'chat' ? GOLD : 'transparent' }}>{t('capsule.modeChat')}</button>
          <button onClick={() => setAideMode('agent')} title={t('capsule.modeAgentTitle')} style={{ ...btnBase, padding: '3px 9px', fontSize: 11, borderRadius: 6, color: aideMode === 'agent' ? '#1c1c1e' : 'rgba(244,244,246,0.8)', background: aideMode === 'agent' ? GOLD : 'transparent' }}>{t('capsule.modeAgent')}</button>
        </div>
        <select
          value={aideProfileId ?? ''}
          onChange={(e) => setAideProfileId(e.target.value || null)}
          title={aideMode === 'agent' ? t('capsule.agentModelTitle') : t('capsule.selectModel')}
          disabled={aideMode === 'agent'}
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#f6f6f8', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 6px', outline: 'none', opacity: aideMode === 'agent' ? 0.5 : 1 }}
        >
          {configuredAideProfiles.length === 0 && <option value="" style={{ background: '#1c1c1e', color: '#f6f6f8' }}>{t('capsule.noModel')}</option>}
          {configuredAideProfiles.map((p) => (
            <option key={p.id} value={p.id} style={{ background: '#1c1c1e', color: '#f6f6f8' }}>
              {p.name || p.model || t('capsule.unnamed')}
            </option>
          ))}
        </select>
        {/* 代理模式请求本就带 aideProfileId 转发给 IDE 执行，故思考开关直接控制 aideProfileId（chat/agent 一致），不再置灰 */}
        <ThinkingToggle
          profileId={aideProfileId}
          compact
          disabled={!aideProfileId || aideBusy}
        />
        {aideBusy && <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.6)' }}>{aideMode === 'agent' ? t('capsule.executing') : t('capsule.thinking')}</span>}
      </div>

      {/* 消息列表 */}
      <div ref={aideScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
        {aideMessages.length === 0 && (
          <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>{t('capsule.aideHint')}</div>
        )}
        {aideMessages.map((m) => (
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
            {m.role === 'assistant' && m.reasoning ? (
              <div style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setAideReasoningOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
                  style={{ ...btnBase, padding: '1px 7px', fontSize: 10.5, borderRadius: 6, background: 'rgba(255,255,255,0.07)', color: 'rgba(244,244,246,0.62)', marginBottom: 4 }}
                >
                  {aideReasoningOpen[m.id] ? '▾' : '▸'} 思考过程{aideReasoningOpen[m.id] ? '' : `（${m.reasoning.length} 字 · 点击展开）`}
                </button>
                {aideReasoningOpen[m.id] && (
                  <div style={{ fontSize: 10.5, lineHeight: 1.55, fontStyle: 'italic', color: 'rgba(244,244,246,0.5)', background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', filter: 'blur(0.3px)' }}>
                    {m.reasoning}
                  </div>
                )}
              </div>
            ) : null}
            {m.content || (m.role === 'assistant' && aideBusy ? '思考中…' : '')}
          </div>
        ))}
      </div>

      {/* 输入区 */}
      <div style={{ marginTop: 8, borderRadius: 12, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.22)', padding: 8 }}>
        <textarea
          value={aideInput}
          onChange={(e) => setAideInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault();
              void sendAide();
            }
          }}
          rows={1}
          placeholder={aideMode === 'agent' ? t('capsule.agentPlaceholder') : (aideProfileId ? t('capsule.inputMsg') : t('capsule.noModel'))}
          disabled={aideMode === 'chat' && !aideProfileId}
          style={{ width: '100%', display: 'block', resize: 'none', maxHeight: 90, minHeight: 34, height: 34, border: 'none', background: 'transparent', color: '#f4f4f6', padding: '4px 4px', fontSize: 12.5, lineHeight: 1.4, outline: 'none', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={() => void sendAide()}
            disabled={aideBusy || !aideInput.trim() || (aideMode === 'chat' && !aideProfileId)}
            title={t('capsule.send')}
            style={{ ...btnBase, width: 34, height: 34, background: 'rgba(230,195,92,0.18)', opacity: aideBusy || !aideInput.trim() || (aideMode === 'chat' && !aideProfileId) ? 0.45 : 1 }}
          >
            <IconSend />
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(CapsuleAide);
