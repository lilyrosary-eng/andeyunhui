// 「AI 对话」模块 · 统计页（与音乐 / 阅读 / 图片 / 视频的统计入口对齐）。
//
// 数据全部来自本地会话（localStorage 里那份 conversations），不请求模型、不上报：
// 会话数、消息数、工具步骤数、回复长度、最近活跃会话。群聊会话按「参与者数」单独统计。
import { useMemo } from 'react';
import type { Conversation } from '@/components/capsule/types';

export interface AiChatStatsPageProps {
  conversations: Conversation[];
  onClose: () => void;
  /** 点「最近活跃」里的会话时跳过去；不传则该行不可点 */
  onSelectConv?: (id: string) => void;
}

const CARD = 'rounded-2xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-stone-800/60 p-4';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={CARD}>
      <p className="text-xs text-neutral-500 dark:text-stone-400">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-neutral-800 dark:text-stone-100">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500">{hint}</p> : null}
    </div>
  );
}

/** 粗略字数：CJK 按 1 字、其它按词长折算（只用于统计展示，不需要精确） */
function approxChars(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.replace(/[\u4e00-\u9fff]/g, ' ');
  const words = rest.split(/\s+/).filter(Boolean).length;
  return cjk + words;
}

export function AiChatStatsPage({ conversations, onClose, onSelectConv }: AiChatStatsPageProps) {
  const stats = useMemo(() => {
    let messages = 0;
    let assistant = 0;
    let user = 0;
    let toolSteps = 0;
    let chars = 0;
    let groups = 0;
    const perConv = conversations.map((c) => {
      const msgs = c.messages || [];
      messages += msgs.length;
      if (c.mode === 'group') groups += 1;
      for (const m of msgs) {
        if (m.role === 'assistant') {
          assistant += 1;
          chars += approxChars(m.content || '');
        } else if (m.role === 'user') {
          user += 1;
        }
        toolSteps += (m.agentSteps?.length ?? 0);
      }
      return { conv: c, count: msgs.length };
    });
    const recent = [...conversations]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 6);
    const active = perConv.filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
    const maxCount = Math.max(1, ...active.map((x) => x.count));
    return {
      messages, assistant, user, toolSteps, groups,
      avgChars: assistant > 0 ? Math.round(chars / assistant) : 0,
      recent, active, maxCount,
    };
  }, [conversations]);

  const fmtTime = (ts: number) => {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div className="absolute inset-0 z-20 overflow-y-auto p-6 bg-[#f5f5f0] dark:bg-[#1c1917]">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">AI 对话 · 统计</h2>
        <button
          onClick={onClose}
          className="btn-press ml-auto rounded-lg px-3 py-1.5 text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        >
          返回
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-2xl">
        <StatCard label="会话" value={String(conversations.length)} hint={`其中群聊 ${stats.groups} 个`} />
        <StatCard label="消息" value={String(stats.messages)} hint={`你 ${stats.user} · AI ${stats.assistant}`} />
        <StatCard label="工具调用" value={String(stats.toolSteps)} hint="agent 模式下累计的工具步骤" />
        <StatCard label="平均回复" value={`${stats.avgChars} 字`} hint="按助手回复估算，仅本机统计" />
      </div>

      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500">最近活跃</h3>
      {stats.recent.length === 0 ? (
        <p className="text-sm text-neutral-400 dark:text-stone-500">还没有任何会话。</p>
      ) : (
        <div className="max-w-2xl space-y-1.5">
          {stats.recent.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelectConv?.(c.id)}
              className="w-full flex items-center gap-3 rounded-xl px-3 py-2 text-left bg-white/60 dark:bg-stone-800/50 border border-black/5 dark:border-white/5 hover:bg-white/90 dark:hover:bg-stone-800/80 transition-colors"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-stone-200">{c.title || '未命名会话'}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-neutral-400 dark:text-stone-500">{c.messages?.length ?? 0} 条</span>
              <span className="shrink-0 text-[11px] tabular-nums text-neutral-400 dark:text-stone-500">{fmtTime(c.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}

      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500">消息最多的会话</h3>
      {stats.active.length === 0 ? (
        <p className="text-sm text-neutral-400 dark:text-stone-500">还没有消息。</p>
      ) : (
        <div className="max-w-2xl space-y-1.5">
          {stats.active.map(({ conv, count }) => (
            <div
              key={conv.id}
              className="flex items-center gap-3 rounded-xl px-3 py-2 bg-white/60 dark:bg-stone-800/50 border border-black/5 dark:border-white/5"
            >
              <span className="w-40 shrink-0 truncate text-xs text-neutral-700 dark:text-stone-200">{conv.title || '未命名会话'}</span>
              <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-black/5 dark:bg-white/10">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.round((count / stats.maxCount) * 100)}%`, background: 'var(--element-bg)' }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500 dark:text-stone-400">{count}</span>
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 max-w-2xl text-[11px] text-neutral-400 dark:text-stone-500">
        说明：统计只读取本地会话记录，不联网、不上报；「平均回复」是字符估算，不等于 token。
      </p>
    </div>
  );
}

export default AiChatStatsPage;
