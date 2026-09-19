// AI 对话 · 「执行轨迹」面板 —— agent 事件溯源日志可视化（append-only 审计视图）。
//
// 数据来源两条，互为补充：
//  ① 内存：消息上的 agentSteps（ai-agent-step 事件实时累积）——运行中立即可见，无需落盘；
//  ② 落盘：ai_agent_events 读取 app_data/ai_sessions/<traceId>.json 的完整事件日志——
//     含 User/Assistant/Tool/Compact(压缩遮蔽)/Interrupted(中断修复) 全量事实，可审计。
// 打开时拉取一次；若会话仍在运行（ai_agent_status.running）则每 3s 轮询刷新，结束后自动停止。
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { AgentStep } from '@/components/capsule/types';

/** 后端 ai_session.rs::SessionEvent（serde 默认 externally tagged：{ "User": {...} }） */
type SessionEvent =
  | { User: { seq: number; content: string } }
  | { Assistant: { seq: number; content: string; tool_calls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }
  | { Tool: { seq: number; call_id: string; name: string; ok: boolean; content: string } }
  | { Compact: { seq: number; summary: string; shadow_until: number } }
  | { Interrupted: { seq: number; call_id: string; content: string } };

// 注意：不能用 keyof SessionEvent —— 联合类型的 keyof 取各成员键的交集（此处为空 = never），
// KIND_LABEL[kind] 会被推断为 never。显式列举变体名。
type EventKind = 'User' | 'Assistant' | 'Tool' | 'Compact' | 'Interrupted';

interface TraceSession {
  id: string;
  created_at: string;
  parent?: string;
  seq: number;
  events: SessionEvent[];
}

const KIND_LABEL: Record<EventKind, string> = {
  User: '用户',
  Assistant: '模型',
  Tool: '工具',
  Compact: '上下文压缩',
  Interrupted: '中断修复',
};

const KIND_CLS: Record<EventKind, string> = {
  User: 'border-sky-400/60 bg-sky-500/5',
  Assistant: 'border-neutral-400/40 bg-black/[0.02] dark:bg-white/[0.03]',
  Tool: 'border-emerald-400/60 bg-emerald-500/5',
  Compact: 'border-amber-400/60 bg-amber-500/5',
  Interrupted: 'border-orange-400/60 bg-orange-500/5',
};

function eventKind(ev: SessionEvent): EventKind {
  return Object.keys(ev)[0] as EventKind;
}

export function AgentTracePanel({
  traceId,
  liveSteps,
  onClose,
}: {
  traceId: string;
  liveSteps?: AgentStep[];
  onClose: () => void;
}) {
  const [session, setSession] = useState<TraceSession | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      const [evRaw, stRaw] = await Promise.all([
        invoke<string>('ai_agent_events', { sourceId: traceId }).catch(() => null),
        invoke<string>('ai_agent_status', { requestId: traceId }).catch(() => null),
      ]);
      if (stop) return;
      if (evRaw) {
        try { setSession(JSON.parse(evRaw) as TraceSession); } catch { /* 日志损坏时保持旧快照 */ }
      }
      if (stRaw) {
        try {
          const st = JSON.parse(stRaw) as { running?: boolean; cancelled?: boolean };
          setRunning(!!st.running);
          setCancelled(!!st.cancelled);
          if (!st.running && timer) { clearInterval(timer); timer = null; }
        } catch { /* ignore */ }
      } else {
        setRunning(false);
      }
      setLoading(false);
    };
    void tick();
    timer = setInterval(() => { void tick(); }, 3000);
    return () => { stop = true; if (timer) clearInterval(timer); };
  }, [traceId]);

  const events = session?.events ?? [];
  const stepCount = useMemo(() => events.filter((e) => eventKind(e) === 'Tool').length, [events]);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[440px] max-w-[92vw] flex flex-col bg-white dark:bg-stone-900 border-l border-black/10 dark:border-white/10 shadow-2xl">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-black/5 dark:border-white/10 shrink-0">
        <Activity size={16} className="text-[var(--element-color-raw)]" />
        <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">执行轨迹</div>
        {running === true && (
          <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Loader2 size={10} className="animate-spin" /> 运行中
          </span>
        )}
        {running === false && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 text-neutral-500 dark:text-stone-400">
            {cancelled ? '已取消' : '已结束'}
          </span>
        )}
        <button
          onClick={onClose}
          className="ml-auto p-1 rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/10"
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>

      <div className="px-4 py-2 text-[11px] text-neutral-400 dark:text-stone-500 border-b border-black/5 dark:border-white/10 shrink-0 truncate" title={traceId}>
        会话 {traceId} · {session ? `${events.length} 条事件 · ${stepCount} 次工具调用` : '尚未落盘'}
        {session?.parent ? ` · 派生自 ${session.parent}` : ''}
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {loading && <div className="text-center text-xs text-neutral-400 dark:text-stone-500 py-8">读取中…</div>}

        {/* 落盘事件时间线（append-only 全量事实） */}
        {events.map((ev, i) => {
          const kind = eventKind(ev);
          const open = !!expanded[i];
          let title = KIND_LABEL[kind];
          let body = '';
          let extra: ReactNode = null;
          let okFlag: boolean | null = null;
          if (kind === 'User') {
            body = (ev as { User: { content: string } }).User.content;
          } else if (kind === 'Assistant') {
            const a = (ev as { Assistant: { content: string; tool_calls: Array<{ function?: { name?: string } }> } }).Assistant;
            body = a.content;
            const names = (a.tool_calls || []).map((t) => t.function?.name).filter(Boolean);
            if (names.length) {
              extra = <div className="text-[11px] text-neutral-500 dark:text-stone-400 mt-0.5">请求工具：{names.join('、')}</div>;
            }
          } else if (kind === 'Tool') {
            const t = (ev as { Tool: { name: string; ok: boolean; content: string } }).Tool;
            title = `工具 · ${t.name}`;
            body = t.content;
            okFlag = t.ok;
          } else if (kind === 'Compact') {
            const c = (ev as { Compact: { summary: string; shadow_until: number } }).Compact;
            title = `上下文压缩（遮蔽 seq ≤ ${c.shadow_until}）`;
            body = c.summary;
          } else if (kind === 'Interrupted') {
            body = (ev as { Interrupted: { content: string } }).Interrupted.content;
          }
          const longBody = body.length > 160;
          const shown = open || !longBody ? body : body.slice(0, 160) + '…';
          return (
            <div
              key={i}
              className={`rounded-xl border px-3 py-2 ${okFlag === false ? 'border-red-400/60 bg-red-500/5' : KIND_CLS[kind]}`}
            >
              <button
                type="button"
                onClick={() => longBody && setExpanded((s) => ({ ...s, [i]: !open }))}
                className="w-full flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-stone-400"
              >
                <span className="font-medium">{title}</span>
                {okFlag != null && <span className={okFlag ? 'text-emerald-500' : 'text-red-400'}>{okFlag ? '成功' : '失败'}</span>}
                {longBody && (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
              </button>
              {extra}
              {shown && <div className="mt-1 text-xs text-neutral-700 dark:text-stone-300 whitespace-pre-wrap break-words">{shown}</div>}
            </div>
          );
        })}

        {/* 未落盘时：内存实时步骤 */}
        {!loading && events.length === 0 && (liveSteps?.length ?? 0) > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-neutral-400 dark:text-stone-500">实时步骤（会话尚未落盘）</div>
            {liveSteps!.map((s, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-xs rounded-xl border border-neutral-200/60 dark:border-stone-700/60 px-2.5 py-1.5"
              >
                <span className={s.ok ? 'text-emerald-500' : 'text-red-400'}>{s.ok ? '✓' : '✗'}</span>
                <div className="min-w-0">
                  <div className="text-neutral-700 dark:text-stone-200 font-medium">{s.name || s.stage}</div>
                  {s.detail && <div className="text-neutral-500 dark:text-stone-400 break-words">{s.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && events.length === 0 && (liveSteps?.length ?? 0) === 0 && (
          <div className="text-center text-xs text-neutral-400 dark:text-stone-500 py-10 leading-relaxed">
            暂无执行记录
            <br />
            <span className="text-[11px]">该轮可能是纯对话（非 agent 模式），或尚未产生事件</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentTracePanel;
