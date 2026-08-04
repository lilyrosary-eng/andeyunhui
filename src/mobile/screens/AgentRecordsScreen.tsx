// Agent 记录浏览页 —— 查看 AI 通过 Agent 能力创建的日历事件 / 待办 / 提醒。
//
// 数据来自 Rust agent_tools_get（同时返回 calendar/todos/reminders 三类）。
// 每条可点击切换完成态（前端 localStorage 维护完成态，不持久化到后端以简化首版）。

import { useEffect, useState } from 'react';
import { Calendar, CheckSquare, Bell, Trash2, Circle, CheckCircle2 } from 'lucide-react';
import { useAgentStore, type AgentData } from '../stores/agentStore';

type Kind = 'calendar' | 'todo' | 'reminder';

const KINDS: { key: Kind; label: string; icon: typeof Calendar }[] = [
  { key: 'calendar', label: '日历事件', icon: Calendar },
  { key: 'todo', label: '待办', icon: CheckSquare },
  { key: 'reminder', label: '提醒', icon: Bell },
];

const DONE_KEY = 'andeyunhui.mobile.agent.done';

function loadDone(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(DONE_KEY) || '[]') as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}
function saveDone(s: Set<string>) {
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch { /* 忽略 */ }
}

export function AgentRecordsScreen() {
  const [data, setData] = useState<AgentData | null>(null);
  const [active, setActive] = useState<Kind>('calendar');
  const [done, setDone] = useState<Set<string>>(loadDone());
  const load = useAgentStore((s) => s.load);
  const deleteRecord = useAgentStore((s) => s.deleteRecord);

  useEffect(() => {
    void load();
    // 这里直接用一次 invoke 拿到 AgentData（store.load 也会刷，但 state 用 useState 镜像）
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const d = await invoke<AgentData>('agent_tools_get');
        setData(d);
      } catch { /* 浏览器预览降级 */ }
    })();
  }, [load]);

  const toggleDone = (id: string) => {
    const next = new Set(done);
    if (next.has(id)) next.delete(id); else next.add(id);
    setDone(next);
    saveDone(next);
  };

  const records: { id: string; title: string; time: string; note: string; created_at: number }[] = (() => {
    if (!data) return [];
    switch (active) {
      case 'calendar': return data.calendar;
      case 'todo': return data.todos;
      case 'reminder': return data.reminders;
      default: return [];
    }
  })();
  const totalCount = data ? data.calendar.length + data.todos.length + data.reminders.length : 0;

  return (
    <div className="px-4 py-5 flex flex-col gap-4">
      <p className="text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
        AI 通过 Agent 能力为你创建的内容（共 {totalCount} 条）。开启「Agent 能力」后，在 AI 对话里说"帮我记一下 XXX"即可自动创建。
      </p>

      {/* 类型切换 */}
      <div className="flex gap-2">
        {KINDS.map((k) => {
          const Icon = k.icon;
          const on = active === k.key;
          const cnt = (() => {
            if (!data) return 0;
            switch (k.key) {
              case 'calendar': return data.calendar.length;
              case 'todo': return data.todos.length;
              case 'reminder': return data.reminders.length;
              default: return 0;
            }
          })();
          return (
            <button
              key={k.key}
              type="button"
              onClick={() => setActive(k.key)}
              className="flex-1 rounded-xl py-2 border active:scale-[0.97] transition-transform"
              style={{
                borderColor: on ? 'var(--element-bg)' : 'var(--border)',
                background: on ? 'var(--element-muted)' : 'transparent',
                color: on ? 'var(--element-bg)' : 'var(--foreground)',
                fontSize: 'var(--m-text-caption)',
              }}
            >
              <span className="flex items-center justify-center gap-1.5">
                <Icon size={14} />
                {k.label} {cnt}
              </span>
            </button>
          );
        })}
      </div>

      {/* 列表 */}
      {records.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border)] p-8 text-center text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-body)' }}>
          还没有{KINDS.find((k) => k.key === active)?.label}。
        </div>
      ) : (
        <section className="rounded-2xl bg-[var(--card)] border border-[var(--border)] overflow-hidden">
          {records.map((r) => {
            const isDone = done.has(r.id);
            return (
              <div
                key={r.id}
                className="flex items-start gap-3 px-4 py-3"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <button
                  type="button"
                  onClick={() => toggleDone(r.id)}
                  className="shrink-0 mt-0.5"
                  aria-label="切换完成"
                >
                  {isDone
                    ? <CheckCircle2 size={20} className="text-[var(--element-bg)]" />
                    : <Circle size={20} className="text-[var(--muted-foreground)]" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div
                    className={isDone ? 'line-through text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'}
                    style={{ fontSize: 'var(--m-text-body)' }}
                  >
                    {r.title}
                  </div>
                  {r.time && (
                    <div className="mt-0.5 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-overline)' }}>
                      {r.time}
                    </div>
                  )}
                  {r.note && (
                    <div className="mt-1 text-[var(--muted-foreground)]" style={{ fontSize: 'var(--m-text-caption)' }}>
                      {r.note}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void deleteRecord(active, r.id)}
                  className="shrink-0 p-1 text-[var(--danger)] active:scale-90 transition-transform"
                  aria-label="删除"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}