// 黄金棋盘浮岛 · AI 编程子面板（从 Capsule.tsx 拆出）。
//
// ## 2026-10-19 架构调整：浮岛变成**独立执行器**（方案 B）
// 此前浮岛**不自己发请求**：它 emit `capsule-ide-chat-request` / `agent-request` 交给 IDE 的
// ai 子插件执行，再由 IDE 把 ai-delta 转成 `capsule-ide-chat-delta` 转发回来。
// 后果：**IDE 模块没加载时浮岛 AI 直接不可用**（只能等 20s 超时后提示"请确认 IDE 已加载"）。
// 现在直接调后端 `ai_chat` / `ai_chat_agent`，监听全局 `ai-*` 事件（按 requestId 过滤），
// 不再依赖任何模块加载。IDE 侧那两个 request 监听保留（无害），但浮岛不再 emit。
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
import { IconClose, IconSend, IconStop } from './icons';
import type { Conversation, ChatMsg } from './types';
import { EVENTS } from '@/core/events/schema';
import { attachMarkdownCopyHandler, injectMarkdownStyles, renderMarkdown } from '@/lib/markdown';
import { mergeConversations } from '@/core/ai/util';

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

// 消息气泡 memo 化：流式输出时 aideMessages 每 tick 都生成新引用，若直接内联渲染会让
// 所有历史气泡全量重渲染。抽成 memo 组件 + 传原始值 props，只有「正在变化」的那条
// 才重渲染（content/reasoning 变化），前面的历史气泡浅比较跳过，长对话翻页/流式卡顿缓解。
const AideBubble = memo(function AideBubble({
  messageId,
  role,
  content,
  error,
  reasoning,
  reasoningOpen,
  busy,
  onToggleReasoning,
}: {
  messageId: string;
  role: string;
  content: string;
  error?: boolean;
  reasoning?: string;
  reasoningOpen: boolean;
  busy: boolean;
  onToggleReasoning: (id: string) => void;
}) {
  const isUser = role === 'user';
  const isAssistant = role === 'assistant';
  return (
    <div
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        background: isUser ? 'rgba(230,195,92,0.18)' : 'rgba(255,255,255,0.08)',
        color: error ? '#ff9a9a' : '#f2f2f4',
        borderRadius: 12,
        padding: '8px 10px',
        fontSize: 12.5,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      }}
    >
      {isAssistant && reasoning ? (
        <div style={{ marginBottom: 6 }}>
          <button
            onClick={() => onToggleReasoning(messageId)}
            style={{ ...btnBase, padding: '1px 7px', fontSize: 10.5, borderRadius: 6, background: 'rgba(255,255,255,0.07)', color: 'rgba(244,244,246,0.62)', marginBottom: 4 }}
          >
            {reasoningOpen ? '▾' : '▸'} 思考过程{reasoningOpen ? '' : `（${reasoning.length} 字 · 点击展开）`}
          </button>
          {reasoningOpen && (
            <div style={{ fontSize: 10.5, lineHeight: 1.55, fontStyle: 'italic', color: 'rgba(244,244,246,0.5)', background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', filter: 'blur(0.3px)' }}>
              {reasoning}
            </div>
          )}
        </div>
      ) : null}
      {content ? (
        // 模型产出是 markdown（代码块/表格/列表），此前当纯文本 pre-wrap 直接显示，
        // 于是 **加粗**、```代码块``` 全都原样露出 —— 与主窗 AI 对话的观感差一截。
        <div className="md-message" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
      ) : (
        isAssistant && busy ? '思考中…' : ''
      )}
    </div>
  );
});

function CapsuleAide() {
  const { t } = useI18n();
  // 流式输出期间才把透明浮窗提到 60fps（静止时 30fps），见 Capsule.tsx 的 repaint rate effect
  const setStream = useCapsuleStore((s) => s.setStream);
  // 浮岛窗是独立 webview：markdown 样式与「复制代码」事件代理必须在这里各挂一次
  useEffect(() => {
    injectMarkdownStyles();
    return attachMarkdownCopyHandler();
  }, []);
  // 共享状态（订阅切片）
  const aiProfiles = useCapsuleStore((s) => s.aiProfiles);
  const aideProfileId = useCapsuleStore((s) => s.aideProfileId);
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
  // 持久化防抖（debounce 600ms）：流式输出时每 tick 都变 aideConversations，直接写会
  // 在 JS 主线程反复做全量 JSON.stringify + localStorage 写入（阻塞渲染）。
  // 静默期（流式结束后 600ms）只写最后一次，杜绝写放大。
  const aidePersistTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (aidePersistTimerRef.current !== null) window.clearTimeout(aidePersistTimerRef.current);
    aidePersistTimerRef.current = window.setTimeout(() => {
      aidePersistTimerRef.current = null;
      try { localStorage.setItem(AIDE_STORE_KEY, JSON.stringify(aideConversations)); } catch { /* 忽略 */ }
    }, 600);
    return () => {
      if (aidePersistTimerRef.current !== null) {
        window.clearTimeout(aidePersistTimerRef.current);
        // 卸载时立即冲刷（防抖窗口内的变更也不能丢，关闭面板/切走保住最后状态）
        try { localStorage.setItem(AIDE_STORE_KEY, JSON.stringify(aideConversations)); } catch { /* 忽略 */ }
      }
    };
  }, [aideConversations]);
  const aideStreamConvIdRef = useRef<string>(aideActiveConvId);
  const updateAideStreamMessages = useCallback((convId: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    setAideConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, messages: updater(c.messages), updatedAt: Date.now() } : c)));
  }, []);
  const aideActiveConv = aideConversations.find((c) => c.id === aideActiveConvId);
  const aideMessages = aideActiveConv?.messages ?? [];

  const [aideInput, setAideInput] = useState('');
  const [aideBusy, setAideBusy] = useState(false);
  // 上报「正在流式输出」给壳，用于把透明浮窗重绘提到 60fps；空闲时回落 30fps。
  // 卸载时显式清零，避免面板关掉后仍占着高刷档。
  useEffect(() => {
    setStream('aide', aideBusy);
    return () => setStream('aide', false);
  }, [aideBusy, setStream]);
  const [aideReasoningOpen, setAideReasoningOpen] = useState<Record<string, boolean>>({});
  // 参考回调稳定化：memo 气泡的 onToggleReasoning 必须引用稳定，否则每渲染变新引用直接打破 memo
  const toggleAideReasoning = useCallback((id: string) => {
    setAideReasoningOpen((o) => ({ ...o, [id]: !o[id] }));
  }, []);
  const aideReqRef = useRef<string | null>(null);
  const aideAsstRef = useRef<string | null>(null);
  const aideScrollRef = useRef<HTMLDivElement | null>(null);
  // 2026-10-19：只保留「智能体（agent）」模式 —— 对话模式已删除，普通聊天由「AI 对话」模块负责。
  // 原来这里还有个「编程 / 攻防」标签切换，攻防改成浮岛独立按钮后也不再需要。

  // 项目根：agent 模式的 <file>/<grep>/<glob> 都要它，否则 agent 只会说"没拿到项目路径"。
  // 默认值来源优先级：浮岛自己上次选的 > IDE 最后打开的项目（IDE 会写 localStorage）。
  const AIDE_ROOT_KEY = 'andeyunhui.capsule.aide.projectRoot';
  const [aideProjectRoot, setAideProjectRoot] = useState<string>(() => {
    try {
      return localStorage.getItem(AIDE_ROOT_KEY) || localStorage.getItem('ide:lastProjectRoot') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      if (aideProjectRoot) localStorage.setItem(AIDE_ROOT_KEY, aideProjectRoot);
    } catch (e) {
      console.warn('[capsule-aide] 保存项目根失败:', e);
    }
  }, [aideProjectRoot]);
  const pickAideProjectRoot = useCallback(async () => {
    try {
      const dir = await invoke<string | null>('pick_directory');
      if (dir) {
        setAideProjectRoot(dir);
        setAiHint(`已关联项目：${dir}`);
      }
    } catch (e) {
      console.error('[capsule-aide] 选择项目目录失败:', e);
      setAiHint('选择项目目录失败：' + String(e));
    }
  }, [setAiHint]);

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
  //
  // ★ 用 **merge 而不是整体替换**（原实现是 `setAideConversations(list)`）。
  //   原因：本组件「壳仅在 expanded && aideOpen && panelReady 时挂载」⇒ 收起浮岛再打开
  //   就会重跑这段。而它**只读不写**后端文件（浮岛本地变更只落 localStorage 的
  //   AIDE_STORE_KEY，从不调 ai_save_conversations）。于是只要文件里有旧内容，
  //   重挂载就会把浮岛这边更新的会话**整个覆盖掉** —— 用户现象正是「切一下就消失」。
  //
  //   merge 的语义与 `useAiChat` 的跨 webview 合并一致：按 id 去重、远端较新则采用、
  //   本地独有的一律保留。两侧 id 空间本来就不同（浮岛 `ac…` / IDE `c_…`），
  //   合并能同时容下，不会互相顶掉。
  useEffect(() => {
    ensureProfiles();
    invoke<{ conversations?: Array<Conversation>; active_id?: string | null }>('ai_get_conversations')
      .then((d) => {
        const remote = (d?.conversations || []).filter((c) => c && Array.isArray(c.messages));
        if (!remote.length) return;
        setAideConversations((local) => {
          const merged = mergeConversations(local, remote);
          // 活跃会话：仍存在就保持当前选择（不要因为远端有 active_id 就把用户正在看的切走）
          const cur = aideActiveConvIdRef.current;
          if (!merged.some((c) => c.id === cur)) {
            const aid = (d.active_id && merged.some((c) => c.id === d.active_id)) ? d.active_id! : merged[0].id;
            setAideActiveConvId(aid);
            aideActiveConvIdRef.current = aid;
          }
          return merged;
        });
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

  // 浮岛「AI 编程」流式事件监听：现在直连后端，监听**全局** `ai-*` 事件（不再是 capsule-ide-*）。
  // 一个 hook 按模式切换写入语义即可 —— 两个实例同时监听 `ai-delta` 会一个 append 一个 replace，
  // 互相抵消（hook 的 deltaMode 在 effect 依赖里，模式一变会重新注册）。
  //   chat 模式：delta 追加 + reasoning 增量
  //   agent 模式：text 整段替换 + agent-step（工具步骤，供执行轨迹）
  useAiStream(
    {
      prefix: EVENTS.chatStream.prefix,
      // agent 回合是「整段已清洗文本」替换 + 工具步骤流；没有 reasoning 增量
      deltaMode: 'replace',
      hasReasoning: false,
      hasAgentStep: true,
    },
    { reqRef: aideReqRef, asstRef: aideAsstRef, streamConvIdRef: aideStreamConvIdRef, updateMessages: updateAideStreamMessages, setBusy: setAideBusy },
  );

  // 自动滚动到底部
  const scrollAideToBottom = () => { const el = aideScrollRef.current; if (el) el.scrollTop = el.scrollHeight; };
  useLayoutEffect(() => {
    scrollAideToBottom();
    const id = requestAnimationFrame(scrollAideToBottom);
    return () => cancelAnimationFrame(id);
  }, [aideMessages, aideActiveConvId]);

  // 浮岛「AI 编程」发送：**直连后端**（方案 B），不再经 IDE 事件桥。
  // chat 模式 → ai_chat（纯对话 + 思考增量）；agent 模式 → ai_chat_agent（工具循环）。
  const sendAide = useCallback(async () => {
    const text = aideInput.trim();
    if (!text || aideBusy) return;
    if (aideReqRef.current) return; // 同步防重入：已有请求在飞时忽略

    const convId = aideActiveConvId;
    const uid = 'u' + Date.now().toString(36);
    const aid = 'a' + Date.now().toString(36);
    aideStreamConvIdRef.current = convId;
    const history = cleanAideHistory(aideMessages.filter((m) => !m.error));
    const reqId = 'cag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    updateAideStreamMessages(convId, (prev) => [...prev, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '' }]);
    setAideConversations((prev) => prev.map((c) => (c.id === convId && (c.title === '新对话' || !c.title.trim())) ? { ...c, title: text.slice(0, CONV_TITLE_MAX) } : c));
    setAideInput('');
    setAideBusy(true);
    aideReqRef.current = reqId;
    aideAsstRef.current = aid;

    // 兜底看门狗：正常结束由 ai-done / ai-error 收口（useAiStream 的 finish）。
    // 这里只防"事件彻底没到"（后端 panic / 窗口重建丢监听）导致永久卡在"思考中"。
    // 5 分钟足够长：agent 多轮工具调用本身就可能跑几分钟。
    const watchdog = setTimeout(() => {
      if (aideReqRef.current !== reqId) return;
      aideReqRef.current = null;
      aideAsstRef.current = null;
      updateAideStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: (m.content ? m.content + '\n\n' : '') + '⚠ 5 分钟未收到结束事件（后台可能仍在跑，或连接已断）。' } : m)));
      setAideBusy(false);
    }, 5 * 60 * 1000);

    const fail = (msg: string) => {
      clearTimeout(watchdog);
      aideReqRef.current = null;
      aideAsstRef.current = null;
      updateAideStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: '⚠ 发送失败：' + msg } : m)));
      setAideBusy(false);
    };

    try {
      await invoke('ai_chat_agent', {
        requestId: reqId,
        messages: [...history, { role: 'user', content: text }],
        profileId: aideProfileId ?? null,
        // 轮数上限 8：浮岛面板小，不追求 20 轮的 ComfyUI 长链
        maxRounds: 8,
        // 项目根决定 file/grep/glob 能否落地；为空时 agent 会明确报"未指定项目根"
        projectRoot: aideProjectRoot || null,
        // 浮岛没有独立的联网开关，默认允许（与「工具常开」策略一致）
        webSearch: true,
      });
    } catch (e) {
      fail(String(e));
    }
  }, [aideInput, aideBusy, aideProfileId, aideMessages, aideActiveConvId, aideProjectRoot, updateAideStreamMessages]);

  /**
   * 停止浮岛当前回合。
   *
   * 浮岛直连后端（方案 B），用的是自己的 requestId，直接按模式调对应的取消命令。
   * 后端取消注册表是**进程级**的，所以 chat/agent 两个 id 空间互不影响。
   *
   * 与 `useAiChat.abort` 同一套做法：先断事件匹配（确定性收口）→ 补「已停止」标记 →
   * 本地复位 busy → 通知后端。置空 `aideReqRef` 同时让那条 20s 超时兜底失效（避免
   * 停止之后再弹一句「IDE 未响应」）。
   */
  const stopAide = useCallback(() => {
    const rid = aideReqRef.current;
    if (!rid) return;
    const aid = aideAsstRef.current;
    const convId = aideStreamConvIdRef.current;
    aideReqRef.current = null;
    aideAsstRef.current = null;
    if (aid) {
      updateAideStreamMessages(convId, (prev) => prev.map((m) => {
        if (m.id !== aid) return m;
        if (m.content.includes('（已停止）')) return m;
        return { ...m, content: (m.content ? m.content + '\n\n' : '') + '（已停止）' };
      }));
    }
    setAideBusy(false);
    void invoke('ai_agent_cancel', { requestId: rid }).catch(() => {});
  }, [updateAideStreamMessages]);

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
        {/* 项目根：agent 模式的 file/grep/glob 依赖它。点一下改选目录。 */}
        <button
          onClick={pickAideProjectRoot}
          title={aideProjectRoot ? `当前项目（点击更换）：${aideProjectRoot}` : '未关联项目：点击选择目录，agent 才能读写文件/搜索代码'}
          style={{
            ...btnBase, flex: '0 1 auto', minWidth: 0, maxWidth: 220, height: 28, padding: '0 8px', fontSize: 11,
            color: aideProjectRoot ? 'rgba(244,244,246,0.85)' : '#e6a23c',
            background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)',
            borderRadius: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {(aideProjectRoot ? aideProjectRoot.split(/[\/]/).filter(Boolean).pop() : '选择项目') || '选择项目'}
        </button>
        <KeepButton pinned={keepOpen} onToggle={() => setKeepOpen(!keepOpen)} size={28} />
        <button onClick={() => setAideOpen(false)} title={t('capsule.backToPlayer')} style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto' }}>
          <IconClose />
        </button>
      </div>
      {/* 第二行：模式切换（对话 / 代理）+ 模型下拉 + 思考开关 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <select
          value={aideProfileId ?? ''}
          onChange={(e) => setAideProfileId(e.target.value || null)}
          title={t('capsule.agentModelTitle')}
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#f6f6f8', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 6px', outline: 'none' }}
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
        {aideBusy && <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.6)' }}>{t('capsule.executing')}</span>}
      </div>

      {/* 消息列表 */}
      <div ref={aideScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
        {aideMessages.length === 0 && (
          <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>{t('capsule.aideHint')}</div>
        )}
        {aideMessages.map((m) => (
          <AideBubble
            key={m.id}
            messageId={m.id}
            role={m.role}
            content={m.content}
            error={m.error}
            reasoning={m.reasoning}
            reasoningOpen={!!aideReasoningOpen[m.id]}
            busy={aideBusy}
            onToggleReasoning={toggleAideReasoning}
          />
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
          placeholder={t('capsule.agentPlaceholder')}
          style={{ width: '100%', display: 'block', resize: 'none', maxHeight: 90, minHeight: 34, height: 34, border: 'none', background: 'transparent', color: '#f4f4f6', padding: '4px 4px', fontSize: 12.5, lineHeight: 1.4, outline: 'none', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4 }}>
          {/* 生成中 → 同一位置变「停止」。此前忙时按钮是 disabled 的，
              等于用户完全没法叫停（IDE 侧跑长回答时只能干等）。 */}
          <button
            onClick={() => (aideBusy ? stopAide() : void sendAide())}
            disabled={!aideBusy && !aideInput.trim()}
            title={aideBusy ? t('capsule.stop') : t('capsule.send')}
            style={{ ...btnBase, width: 34, height: 34, background: aideBusy ? 'rgba(244,244,246,0.16)' : 'rgba(230,195,92,0.18)', opacity: !aideBusy && !aideInput.trim() ? 0.45 : 1 }}
          >
            {aideBusy ? <IconStop /> : <IconSend />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(CapsuleAide);
