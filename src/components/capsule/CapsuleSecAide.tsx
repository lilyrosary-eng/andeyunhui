// 黄金棋盘浮岛 · 攻防 AI 面板（2026-10-19 新增）。
//
// ## 为什么有这个东西
// 原「攻防」模块的 AI 侧栏（plugins/茑萝/gongfang/src/GongfangAiSidebar.tsx，1023 行）已删除，
// 主窗口腾出侧栏宽度。攻防的自然语言调度统一收进浮岛，与「编程」并列成为第二个标签页。
//
// ## 与旧实现的关键差异：不再用 `<cmd>` 文本协议
// 旧侧栏让模型输出 `<cmd action="scan" host="..."/>`，前端用正则解析后逐条 invoke。
// 那是"用文本假装工具调用"——模型一旦漏掉尖括号/属性引号就整条失效，且没有参数校验。
// 这里直接走 `ai_chat_agent` + 后端的 `gongfang` 工具（68 个 cmd 分支，见
// src-tauri/src/services/ai_service/gongfang_tools.rs），由端点原生 tool_calls 驱动。
// 能力覆盖：旧侧栏的 20 多个 action 全部在 `gongfang` 工具的 cmd 枚举里。
//
// ## 布局
// 刻意与旧侧栏一致：顶部「内核状态 + 新建 + 清空」→ 快捷指令行 → 消息区 → 输入框。
// 这样用户从主窗口迁过来不用重新学一遍位置。
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAiStream } from './useAiStream';
import { btnBase, GOLD } from './constants';
import { IconClose, IconSend, IconStop } from './icons';
import { TurnRail } from '@/components/chat/TurnRail';
import { jumpToMessageIndex } from '@/components/chat/jumpToMessage';
import { estimateMessageHeight } from '@/components/chat/estimateMessageHeight';
import { activeTurnMessageIndex } from '@/components/chat/activeTurn';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { ThinkingToggle } from '@/core/ai/ThinkingToggle';
import { KeepButton } from '@/components/KeepButton';
import type { Conversation, ChatMsg } from './types';
import { EVENTS } from '@/core/events/schema';
import { attachMarkdownCopyHandler, injectMarkdownStyles, renderMarkdown } from '@/lib/markdown';

const SEC_STORE_KEY = 'andeyunhui.capsule.sec.conversations.v1';
const SEC_ACTIVE_KEY = 'andeyunhui.capsule.sec.activeConv'; // 上次选中的会话 id（收起/展开后恢复）
const CONV_TITLE_MAX = 20;
const SEC_MAX_ROUNDS = 10;

/**
 * 攻防系统提示。旧版是 150 行 `<cmd>` 协议的 few-shot；这里改成工具调用版：
 * 说清"有哪些 cmd、按什么顺序用、什么时候停"，具体参数由模型按 schema 填。
 */
const SEC_SYSTEM = [
  '你是「茑萝 · 攻防」的 AI 指挥官。用户用自然语言下达意图，你调度攻防内核完成。',
  '',
  '## 工具',
  '你有一个名为 `gongfang` 的工具，参数 `cmd` 指定操作，其余参数按需填写。常用 cmd：',
  '- `status` / `start` / `stop`：内核状态与启停（start 接受 profile_id）',
  '- `fetch`（url）：真实 HTTP 抓取，返回正文摘要与链接',
  '- `scan`（host, ports 可选）：TCP 端口扫描',
  '- `waf` / `tech` / `paths` / `methods` / `wellknown`（url）：目标侦察',
  '- `events_recent`（n）/ `metrics_history`（seconds）：内核事件与指标',
  '- `humanize`（level 0-10）/ `fitness` / `fitness_migrate`：自动化模板调优',
  '- `gateway_status` / `gateway_rotate`（mode）/ `gateway_throttle`（percent）：网关调度',
  '- `crypto`（hex）/ `symbols` / `binary_analyze`（path）：逆向与静态分析',
  '- `target_list` / `target_save` / `target_activate`：目标工作区',
  '',
  '## 执行原则',
  '1. 需要内核的动作先 `status`；未运行则先 `start`。',
  '2. 一次做一件事：拿到工具结果再决定下一步，不要凭猜继续。',
  '3. 用户没给 URL/目标时，先问一句，不要假设。',
  '4. 只对用户明确授权或本机/内网目标操作；不洪泛、不越权。',
  '5. 收尾用 3-5 行中文总结（做了什么、结果、建议下一步），不要贴大段 JSON。',
].join('\n');

const SecBubble = memo(function SecBubble({ role, content, toolNote, error, reasoning }: { role: string; content: string; toolNote?: boolean; error?: boolean; reasoning?: string }) {
  // toolNote：快捷指令的本地执行结果 —— 灰底等宽、不冒充用户发言
  if (toolNote) {
    return (
      <div
        style={{
          fontSize: 11.5,
          lineHeight: 1.5,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: error ? '#f0a3a3' : 'rgba(244,244,246,0.72)',
          background: 'rgba(255,255,255,0.04)',
          border: `1px solid ${error ? 'rgba(240,120,120,0.35)' : 'rgba(255,255,255,0.10)'}`,
          borderRadius: 8,
          padding: '6px 8px',
          maxHeight: 260,
          overflow: 'auto',
        }}
      >
        {content}
      </div>
    );
  }
  const isUser = role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '86%',
          padding: '7px 10px',
          borderRadius: 10,
          fontSize: 12.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: isUser ? '#1c1c1e' : '#f2f2f4',
          background: isUser ? GOLD : 'rgba(255,255,255,0.07)',
          border: isUser ? 'none' : '1px solid rgba(255,255,255,0.10)',
        }}
      >
        {reasoning ? (
          <details style={{ marginBottom: 6 }}>
            <summary style={{ cursor: 'pointer', fontSize: 10.5, fontStyle: 'italic', color: 'rgba(244,244,246,0.55)', listStyle: 'none' }}>
              思考过程（{reasoning.length} 字 · 点击展开）
            </summary>
            <div style={{
              marginTop: 4, fontSize: 10.5, lineHeight: 1.55, fontStyle: 'italic',
              color: 'rgba(244,244,246,0.5)', background: 'rgba(0,0,0,0.18)',
              borderRadius: 6, padding: '5px 7px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {reasoning}
            </div>
          </details>
        ) : null}
        {/* 模型产出按 markdown 渲染（表格/列表/代码块）；用户气泡同样处理，保持一致 */}
        <div className="md-message" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
      </div>
    </div>
  );
});

function loadConvs(): Conversation[] {
  try {
    const raw = localStorage.getItem(SEC_STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => c && Array.isArray(c.messages)) as Conversation[];
  } catch (e) {
    console.warn('[capsule-sec] 读取攻防会话失败:', e);
    return [];
  }
}

function CapsuleSecAideInner() {
  const setSecOpen = useCapsuleStore((s) => s.setSecOpen);
  const setStream = useCapsuleStore((s) => s.setStream);
  const aiProfiles = useCapsuleStore((s) => s.aiProfiles);
  const aideProfileId = useCapsuleStore((s) => s.aideProfileId);
  const setAideProfileId = useCapsuleStore((s) => s.setAideProfileId);
  const ensureProfiles = useCapsuleStore((s) => s.ensureProfiles);
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  const configuredAideProfiles = aiProfiles.filter((p) => p.api_key && p.api_key.trim());

  useEffect(() => {
    injectMarkdownStyles();
    return attachMarkdownCopyHandler();
  }, []);
  // 与 AI 编程共用同一个模型档案与思考开关（后端暴露的通用能力，攻防不另起一套）。
  useEffect(() => { ensureProfiles(); }, [ensureProfiles]);

  const initialSecConvs = useMemo(() => {
    const list = loadConvs();
    return list.length ? list : [{ id: 'sc' + Date.now().toString(36), title: '新对话', messages: [], updatedAt: Date.now() }];
  }, []);
  const [convs, setConvs] = useState<Conversation[]>(initialSecConvs);
  const [activeId, setActiveId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(SEC_ACTIVE_KEY);
      if (saved && initialSecConvs.some((c) => c.id === saved)) return saved;
    } catch { /* 忽略 */ }
    return initialSecConvs[0]?.id ?? '';
  });
  // 收起浮岛会卸载本组件：记住当前会话，重新展开时继续同一会话。
  useEffect(() => {
    try { localStorage.setItem(SEC_ACTIVE_KEY, activeId); } catch { /* 忽略 */ }
  }, [activeId]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // 流式期间上报，壳据此把透明浮窗重绘提到 60fps；空闲回落 30fps。
  // 必须放在 busy 声明之后 —— 依赖数组在渲染期求值，提前引用会 TDZ。
  useEffect(() => {
    setStream('sec', busy);
    return () => setStream('sec', false);
  }, [busy, setStream]);

  const reqRef = useRef<string | null>(null);
  const asstRef = useRef<string | null>(null);
  const streamConvIdRef = useRef<string>(activeId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const conv = convs.find((c) => c.id === activeId) ?? convs[0];
  const messages = conv?.messages ?? [];

  // 消息虚拟化：只渲染可视区；动态高度测量 + 流式跟随底部。
  const secVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateMessageHeight(messages[i]),
    overscan: 6,
    measureElement: (el) => el.getBoundingClientRect().height,
  });
  // 导轨：每条 user 消息算一轮（只做舒缓模式：22px 间距 + 导轨自身滚动）。
  const secRailItems = useMemo(
    () => messages.flatMap((m, index) => (m.role === 'user'
      ? [{ id: m.id, messageIndex: index, label: m.content || '（本地指令）' }]
      : [])),
    [messages],
  );
  const [secPinnedTurn, setSecPinnedTurn] = useState<number | null>(null);
  const secPinUntilRef = useRef(0);
  const secStickBottomRef = useRef(true);
  const secRailActive = secPinnedTurn ?? activeTurnMessageIndex(secVirtualizer, secRailItems);
  const jumpSecToMessage = useCallback((messageIndex: number) => {
    secPinUntilRef.current = Date.now() + 1500;
    setSecPinnedTurn(messageIndex);
    jumpToMessageIndex(secVirtualizer, scrollRef.current, messageIndex);
  }, [secVirtualizer]);
  useEffect(() => {
    setSecPinnedTurn(null);
  }, [activeId, messages.length]);

  // 持久化（防抖 400ms，避免流式每 tick 写 localStorage）
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(SEC_STORE_KEY, JSON.stringify(convs.slice(0, 30)));
      } catch (e) {
        console.error('[capsule-sec] 保存攻防会话失败（localStorage 可能已满）:', e);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [convs]);

  const updateMessages = useCallback((convId: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    setConvs((prev) => prev.map((c) => (c.id === convId ? { ...c, messages: updater(c.messages), updatedAt: Date.now() } : c)));
  }, []);

  useAiStream(
    { prefix: EVENTS.chatStream.prefix, deltaMode: 'replace', hasReasoning: true, hasAgentStep: false },
    { reqRef, asstRef, streamConvIdRef, updateMessages, setBusy },
  );

  useLayoutEffect(() => {
    if (!secStickBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const newConv = useCallback(() => {
    secStickBottomRef.current = true;
    const id = 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    setConvs((prev) => [{ id, title: '新对话', messages: [], updatedAt: Date.now() }, ...prev]);
    setActiveId(id);
    setInput('');
    setBusy(false);
    reqRef.current = null;
    asstRef.current = null;
    streamConvIdRef.current = id;
  }, []);

  const clearAll = useCallback(() => {
    secStickBottomRef.current = true;
    const id = 'sc' + Date.now().toString(36);
    setConvs([{ id, title: '新对话', messages: [], updatedAt: Date.now() }]);
    setActiveId(id);
    streamConvIdRef.current = id;
    reqRef.current = null;
    asstRef.current = null;
    setBusy(false);
    try { localStorage.removeItem(SEC_STORE_KEY); } catch { /* 忽略 */ }
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || reqRef.current) return;
    const cid = activeId;
    const uid = 'su' + Date.now().toString(36);
    const aid = 'sa' + Date.now().toString(36);
    const reqId = 'sec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    streamConvIdRef.current = cid;
    secStickBottomRef.current = true;

    const history = messages
      .filter((m) => !m.error && !m.toolNote && m.content.trim())
      .slice(-24)
      .map((m) => ({ role: m.role, content: m.content }));

    updateMessages(cid, (prev) => [...prev, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '' }]);
    setConvs((prev) => prev.map((c) => (c.id === cid && (!c.title.trim() || c.title === '新对话') ? { ...c, title: text.slice(0, CONV_TITLE_MAX) } : c)));
    setInput('');
    setBusy(true);
    reqRef.current = reqId;
    asstRef.current = aid;

    try {
      await invoke('ai_chat_agent', {
        requestId: reqId,
        messages: [...history, { role: 'user', content: text }],
        system: SEC_SYSTEM,
        profileId: aideProfileId ?? null,
        maxRounds: SEC_MAX_ROUNDS,
        // 攻防工具不需要项目根；给 null 让 file/grep 明确报"未指定项目根"而不是乱猜目录
        projectRoot: null,
        // 与 AI 编程对齐：联网工具由后端暴露，攻防侦察也能用
        webSearch: true,
      });
    } catch (e) {
      reqRef.current = null;
      asstRef.current = null;
      updateMessages(cid, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: '⚠ 发送失败：' + String(e) } : m)));
      setBusy(false);
    }
  }, [activeId, aideProfileId, busy, input, messages, updateMessages]);

  const stop = useCallback(() => {
    const rid = reqRef.current;
    if (!rid) return;
    reqRef.current = null;
    asstRef.current = null;
    setBusy(false);
    void invoke('ai_agent_cancel', { requestId: rid }).catch((e) => console.error('[capsule-sec] 取消失败:', e));
  }, []);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px', background: 'rgba(0,0,0,0.2)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }} onClick={(e) => e.stopPropagation()}>
      {/* 顶部：会话切换 + 新建 + 清空。
          内核状态/指标/事件等「功能块」已迁到攻防模块自己的侧栏（2026-10-19），
          浮岛这边只负责对话，不再重复显示。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#f2f2f4' }}>AI 攻防</span>
        <select
          value={activeId}
          onChange={(e) => {
            secStickBottomRef.current = true;
            setActiveId(e.target.value);
            streamConvIdRef.current = e.target.value;
            setBusy(false);
            reqRef.current = null;
            asstRef.current = null;
          }}
          style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#f6f6f8', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 6px', outline: 'none' }}
        >
          {convs.map((c) => (
            <option key={c.id} value={c.id} style={{ background: '#1c1c1e', color: '#f6f6f8' }}>
              {(c.title || '新对话').slice(0, CONV_TITLE_MAX)}
            </option>
          ))}
        </select>
        <button onClick={newConv} title="新建对话" style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto', color: GOLD, background: 'rgba(230,195,92,0.14)', fontSize: 16, lineHeight: 1 }}>+</button>
        <button onClick={clearAll} title="清空全部攻防对话" style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto', color: 'rgba(244,244,246,0.8)', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', fontSize: 11 }}>清</button>
        <KeepButton pinned={keepOpen} onToggle={() => setKeepOpen(!keepOpen)} size={28} />
        {/* 返回：AI 编程面板一直有这个 ×，攻防迁来时漏了（用户 2026-10-19 反馈） */}
        <button onClick={() => setSecOpen(false)} title="收起（回到播放器）" style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto' }}>
          <IconClose />
        </button>
      </div>

      {/* 第二行：模型档案 + 思考开关（与 AI 编程对齐；后端 ai_chat_agent 支持 profileId） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <select
          value={aideProfileId ?? ''}
          onChange={(e) => setAideProfileId(e.target.value || null)}
          title="攻防使用哪个模型档案"
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#f6f6f8', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 6px', outline: 'none' }}
        >
          {configuredAideProfiles.length === 0 && <option value="" style={{ background: '#1c1c1e', color: '#f6f6f8' }}>未配置模型</option>}
          {configuredAideProfiles.map((p) => (
            <option key={p.id} value={p.id} style={{ background: '#1c1c1e', color: '#f6f6f8' }}>
              {p.name || p.model || '未命名'}
            </option>
          ))}
        </select>
        <ThinkingToggle profileId={aideProfileId} compact disabled={!aideProfileId || busy} />
        {busy && <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.6)' }}>执行中</span>}
      </div>

      {/* 消息区：虚拟化 + 右侧轮次导轨 */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', marginTop: 8 }}>
        <div
          ref={scrollRef}
          style={{ height: '100%', overflowY: 'auto', paddingRight: 40 }}
          onScroll={() => {
            const el = scrollRef.current;
            if (el) secStickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            if (Date.now() > secPinUntilRef.current) setSecPinnedTurn(null);
          }}
        >
          {messages.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.45)', lineHeight: 1.7 }}>
              用自然语言下达意图，例如：<br />
              · 「扫一下 192.168.1.1 开了哪些端口」<br />
              · 「爬 https://example.com 看有什么」<br />
              · 「内核跑得怎么样？看下最近指标」
            </div>
          )}
          <div style={{ position: 'relative', height: secVirtualizer.getTotalSize() }}>
            {secVirtualizer.getVirtualItems().map((vi) => {
              const m = messages[vi.index];
              if (!m) return null;
              return (
                <div
                  key={m.id}
                  data-index={vi.index}
                  data-msg-index={vi.index}
                  ref={secVirtualizer.measureElement}
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    transform: `translateY(${vi.start}px)`,
                    paddingBottom: 8,
                  }}
                >
                  <SecBubble role={m.role} content={m.content} toolNote={m.toolNote} error={m.error} reasoning={m.reasoning} />
                </div>
              );
            })}
          </div>
        </div>
        <TurnRail
          items={secRailItems}
          activeMessageIndex={secRailActive}
          onJump={jumpSecToMessage}
          accent={GOLD}
          markScope={`sec:${activeId}`}
        />
      </div>

      {/* 输入区 */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginTop: 8, background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 10, padding: 4 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="描述你要做的攻防任务（Enter 发送，Shift+Enter 换行）"
          style={{ flex: 1, minHeight: 34, maxHeight: 120, resize: 'none', border: 'none', background: 'transparent', color: '#f4f4f6', padding: '6px 6px', fontSize: 12.5, lineHeight: 1.45, outline: 'none', fontFamily: 'inherit' }}
        />
        {busy ? (
          <button onClick={stop} title="停止本轮" style={{ ...btnBase, width: 34, height: 34, background: 'rgba(244,244,246,0.16)' }}>
            <IconStop />
          </button>
        ) : (
          <button
            onClick={() => void send()}
            disabled={!input.trim()}
            style={{ ...btnBase, width: 34, height: 34, background: 'rgba(230,195,92,0.18)', opacity: input.trim() ? 1 : 0.45 }}
          >
            <IconSend />
          </button>
        )}
      </div>
    </div>
  );
}

// 壳会在播放进度等状态变化时重渲染；面板自己是 memo 的，避免整块 920×736 面板跟着重绘。
export default memo(CapsuleSecAideInner);
