// AI 协作 · 房间视图（P1）。
//
// 只做「看得见的闭环」：房间成员、事件时间线、任务看板、运行演示。
// 不在这里做组态画布 —— 那是 P3 的事，先把任务分派与真实 harness 执行验证透。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2, Clock, Copy, Download, FolderOpen, Loader2, Network, Pencil, Play, Plug, Send, Square,
  Users, X, XCircle, type LucideIcon,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type {
  CollabAssignment, CollabAssignmentStatus, CollabEvent, CollabHarnessInfo, CollabMcpInfo,
  CollabMemberInput, CollabPermissionRequest, CollabRoom, DshSessionSummary,
} from '@/core/ai/aiCollab';
import { DshSessionImportDialog } from '@/components/ai-chat/DshSessionImportDialog';
import { ApprovalBar } from '@/components/ai-chat/ApprovalBar';
import { CollabCanvas } from '@/components/ai-chat/CollabCanvas';
import { agentMeta, formatDuration, formatTokens } from '@/components/ai-chat/collabDisplay';
import { TurnRail } from '@/components/chat/TurnRail';

interface AiCollabViewProps {
  room: CollabRoom | null;
  events: CollabEvent[];
  assignments: CollabAssignment[];
  busy: boolean;
  error: string | null;
  /** harness 目录：新建房间时按它列可选项（只列可用的） */
  harnesses?: CollabHarnessInfo[];
  /** 新建房间：成员各自选 harness 与模型，主导由成员里指定 */
  onCreateRoom?: (members: CollabMemberInput[], name: string) => void;
  /** 编辑当前房间：改名称 / 成员 / 主导，保留事件与任务历史 */
  onUpdateRoom?: (roomId: string, members: CollabMemberInput[], name: string) => void;
  /** 新建房间弹窗开关由宿主控制：侧栏「新建房间」与空状态按钮走同一条路径 */
  builderOpen: boolean;
  onOpenBuilder: () => void;
  onCloseBuilder: () => void;
  deepseekAvailable?: boolean;
  dshSessions: DshSessionSummary[];
  dshSessionsLoading: boolean;
  onLoadDshSessions: () => void;
  onImportDshSession: (sessionId: string) => void;
  onSetWorkspace: (workspace: string | null) => void;
  /** 发消息；assigneeId 指定派给谁，省略时发主导 */
  onSend: (text: string, assigneeId?: string) => void;
  onDemo: () => void;
  onCancel: (assignmentId: string) => void;
  /** 等待用户确认的 ACP 权限请求 */
  permission?: CollabPermissionRequest | null;
  /** 回复权限请求；null 表示拒绝 */
  onReplyPermission?: (optionId: string | null) => void;
}

const STATUS_META: Record<CollabAssignmentStatus, { label: string; cls: string; icon: LucideIcon }> = {
  queued: { label: '排队', cls: 'text-neutral-500 dark:text-stone-400', icon: Clock },
  running: { label: '执行中', cls: 'text-sky-600 dark:text-sky-400', icon: Loader2 },
  waiting: { label: '等待中', cls: 'text-amber-600 dark:text-amber-400', icon: Clock },
  completed: { label: '已完成', cls: 'text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  failed: { label: '失败', cls: 'text-red-600 dark:text-red-400', icon: XCircle },
  cancelled: { label: '已取消', cls: 'text-neutral-500 dark:text-stone-500', icon: Square },
};

function agentName(room: CollabRoom | null, agentId: string | null | undefined): string {
  if (!room || !agentId) return '系统';
  return room.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

function shortPath(path: string | null | undefined): string {
  const value = (path ?? '').trim();
  if (!value) return '未绑定工作目录';
  return value.length > 58 ? `…${value.slice(-56)}` : value;
}

function StatusLine({ event, room }: { event: CollabEvent; room: CollabRoom | null }) {
  const assignment = event.assignment;
  if (!assignment) return null;
  const meta = STATUS_META[assignment.status] ?? STATUS_META.queued;
  const Icon = meta.icon;
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-[11px] text-neutral-400 dark:text-stone-500">
      <Icon size={12} className={`${meta.cls} ${assignment.status === 'running' ? 'animate-spin' : ''}`} />
      <span className={meta.cls}>
        {agentName(room, assignment.assigneeId)} · {meta.label}
      </span>
      <span className="max-w-[50%] truncate opacity-80">{assignment.brief}</span>
    </div>
  );
}

function Timeline({ room, events }: { room: CollabRoom; events: CollabEvent[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);

  // 一轮 = 一条用户消息。导轨的 messageIndex 用 events 下标，跳转时直接按它定位。
  const railItems = useMemo(
    () =>
      events.flatMap((event, index) => {
        if (event.kind !== 'message' || !event.text) return [];
        const role = event.data?.role ?? (event.agentId ? 'agent' : 'user');
        if (role !== 'user') return [];
        return [{ id: `evt-${event.seq}`, messageIndex: index, label: event.text }];
      }),
    [events],
  );

  // 非虚拟列表：按滚动位置找「阅读线」上方最后一轮；导轨需要的是轮次下标本身。
  const syncActiveTurn = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const line = el.scrollTop + Math.min(96, el.clientHeight * 0.2);
    let next: number | null = null;
    el.querySelectorAll<HTMLElement>('[data-turn]').forEach((node) => {
      const index = Number(node.dataset.turn);
      if (Number.isFinite(index) && node.offsetTop <= line) next = index;
    });
    setActiveTurn(next);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    syncActiveTurn();
  }, [events.length, syncActiveTurn]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => syncActiveTurn();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [syncActiveTurn]);

  const jumpToTurn = useCallback((messageIndex: number) => {
    scroller.current
      ?.querySelector<HTMLElement>(`[data-turn="${messageIndex}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1">
    <div ref={scroller} className="relative min-w-0 flex-1 overflow-y-auto px-5 py-4 space-y-3">
      {events.length === 0 && (
        <div className="flex h-full items-center justify-center text-xs text-neutral-400 dark:text-stone-500">
          还没有协作记录。发一条消息，或点「运行演示」。
        </div>
      )}
      {events.map((event, index) => {
        if (event.kind.startsWith('assignment.')) {
          return <StatusLine key={event.seq} event={event} room={room} />;
        }
        if (event.kind !== 'message') {
          if (event.kind === 'room.updated') return null;
          return (
            <div key={event.seq} className="text-center text-[11px] text-neutral-400 dark:text-stone-500">
              {event.text}
            </div>
          );
        }
        const role = event.data?.role ?? (event.agentId ? 'agent' : 'user');
        const isUser = role === 'user';
        const isSystem = role === 'system';
        if (isSystem) {
          return (
            <div key={event.seq} className="text-center text-[11px] text-neutral-400 dark:text-stone-500">
              {event.text}
            </div>
          );
        }
        return (
          <div
            key={event.seq}
            data-turn={isUser ? index : undefined}
            className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[78%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
              <span className="text-[10px] text-neutral-400 dark:text-stone-500">
                {isUser
                  ? (event.data?.target ? `我 → ${agentName(room, String(event.data.target))}` : '我')
                  : agentName(room, event.agentId)}
              </span>
              <div
                className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  isUser
                    ? 'bg-[var(--element-color-raw)] text-white'
                    : 'bg-neutral-100 text-neutral-800 dark:bg-stone-800 dark:text-stone-100'
                }`}
              >
                {event.text}
              </div>
            </div>
          </div>
        );
      })}
    </div>
      <TurnRail
        items={railItems}
        activeMessageIndex={activeTurn}
        onJump={jumpToTurn}
        accent="#6366f1"
        markScope={`collab:${room.id}`}
      />
    </div>
  );
}

function Board({
  assignments,
  room,
  onCancel,
}: {
  assignments: CollabAssignment[];
  room: CollabRoom;
  onCancel: (assignmentId: string) => void;
}) {
  const ordered = useMemo(
    () => [...assignments].sort((a, b) => b.createdAt - a.createdAt),
    [assignments],
  );
  // 房间累计 token：只统计外部回报过用量的任务，没回报的按未知处理（不按 0 计）。
  const totalTokens = useMemo(
    () => assignments.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0),
    [assignments],
  );
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-neutral-200/70 bg-neutral-50/60 dark:border-stone-700/60 dark:bg-stone-900/40 lg:flex">
      <div className="flex items-center gap-2 border-b border-neutral-200/70 px-4 py-3 text-xs font-semibold text-neutral-600 dark:border-stone-700/60 dark:text-stone-300">
        <Network size={14} />
        任务看板
        <span className="ml-auto text-[10px] font-normal text-neutral-400">{assignments.length}</span>
        {totalTokens > 0 && (
          <span
            className="text-[10px] font-normal text-neutral-400 dark:text-stone-500"
            title="本房间已回报用量的任务累计 token"
          >
            {formatTokens(totalTokens)} tok
          </span>
        )}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {ordered.length === 0 && (
          <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400 dark:border-stone-700 dark:text-stone-500">
            任务会在派单后出现在这里
          </div>
        )}
        {ordered.map((assignment) => {
          const meta = STATUS_META[assignment.status] ?? STATUS_META.queued;
          const Icon = meta.icon;
          const canCancel = assignment.status === 'queued' || assignment.status === 'running';
          return (
            <div
              key={assignment.id}
              className="rounded-xl border border-neutral-200/80 bg-white/70 p-3 text-xs shadow-sm dark:border-stone-700/60 dark:bg-stone-800/50"
            >
              <div className="flex items-center gap-1.5">
                <Icon
                  size={12}
                  className={`${meta.cls} ${assignment.status === 'running' ? 'animate-spin' : ''}`}
                />
                <span className={`font-medium ${meta.cls}`}>{meta.label}</span>
                <span className="ml-auto text-[10px] text-neutral-400 dark:text-stone-500">
                  {agentName(room, assignment.assigneeId)}
                  {assignment.claimedBy ? ` · ${assignment.claimedBy}` : ''}
                </span>
              </div>
              <div className="mt-1.5 line-clamp-2 text-neutral-700 dark:text-stone-300">{assignment.brief}</div>
              {assignment.result && (
                <div className="mt-1.5 line-clamp-3 rounded-lg bg-emerald-500/5 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                  {assignment.result}
                </div>
              )}
              {(assignment.durationMs != null || assignment.usage?.totalTokens) && (
                <div className="mt-1.5 flex items-center gap-2 text-[10px] text-neutral-400 dark:text-stone-500">
                  {assignment.durationMs != null && <span>耗时 {formatDuration(assignment.durationMs)}</span>}
                  {assignment.usage?.totalTokens ? (
                    <span>{formatTokens(assignment.usage.totalTokens)} tokens</span>
                  ) : null}
                </div>
              )}
              {canCancel && (
                <button
                  onClick={() => onCancel(assignment.id)}
                  className="btn-press mt-2 text-[11px] text-neutral-400 hover:text-red-500"
                >
                  取消任务
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    };
    // 与聊天消息一致：Tauri webview 下 clipboard 可能不可用，退回 execCommand。
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done();
      } catch {
        // 复制失败不是关键路径，忽略。
      }
    };
    if (!navigator.clipboard?.writeText) {
      legacy();
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(() => legacy());
  };
  return (
    <button
      onClick={copy}
      className="btn-press flex items-center gap-1 rounded-lg border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
    >
      <Copy size={12} />
      {copied ? '已复制' : label}
    </button>
  );
}

/** MCP 接入说明：外部 harness 不需要写适配器，配一个 MCP server 即可参与。 */
function McpDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<CollabMcpInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<CollabMcpInfo>('collab_mcp_info')
      .then((value) => {
        if (alive) setInfo(value);
      })
      .catch((err) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const snippet = info ? JSON.stringify(info.config, null, 2) : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[78vh] w-[620px] max-w-full flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-5 py-3 dark:border-stone-700">
          <Plug size={18} className="text-indigo-600 dark:text-indigo-400" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">MCP 接入</div>
            <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500">
              Trae / WorkBuddy 等 harness 配一个 MCP server 就能加入房间：读事件、发言、建任务、认领、完成。
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-press ml-auto rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            title="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-red-600 dark:text-red-400">{error}</div>}
          {!info && !error && (
            <div className="flex items-center justify-center gap-2 py-10 text-neutral-400 dark:text-stone-500">
              <Loader2 size={14} className="animate-spin" />
              读取 MCP 配置…
            </div>
          )}
          {info && (
            <>
              <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/70 p-3 dark:border-stone-700/60 dark:bg-stone-800/40">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-neutral-700 dark:text-stone-200">数据根目录</span>
                  <CopyButton text={info.root} />
                </div>
                <div className="mt-1 break-all font-mono text-[11px] text-neutral-500 dark:text-stone-400">
                  {info.root}
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-neutral-400 dark:text-stone-500">
                  与宿主共用同一份 rooms.json / 事件流；换目录用环境变量 ANDY_COLLAB_ROOT 覆盖。
                </div>
              </div>

              <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3 text-[11px] leading-relaxed text-indigo-700 dark:text-indigo-300">
                MCP 由应用本体以 <code className="rounded bg-white/60 px-1 font-mono dark:bg-stone-800">{info.args.join(' ')}</code>
                模式提供，安装包不需要额外二进制；升级应用即同步升级 MCP。
                {info.binary && (
                  <div className="mt-1 break-all font-mono text-[10px] text-neutral-500 dark:text-stone-400">
                    开发用独立二进制：{info.binary}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-medium text-neutral-700 dark:text-stone-200">MCP 配置</span>
                  <CopyButton text={snippet} label="复制 JSON" />
                </div>
                <pre className="max-h-56 overflow-auto rounded-xl bg-neutral-900 p-3 text-[11px] leading-relaxed text-neutral-200">
                  {snippet}
                </pre>
              </div>

              <div>
                <div className="mb-1 font-medium text-neutral-700 dark:text-stone-200">工具</div>
                <div className="flex flex-wrap gap-1">
                  {info.tools.map((tool) => (
                    <span
                      key={tool}
                      className="rounded-full border border-neutral-200 bg-white/70 px-2 py-0.5 font-mono text-[10px] text-neutral-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
                <div className="mt-2 text-[10px] leading-relaxed text-neutral-400 dark:text-stone-500">
                  典型流程：collab_list_rooms → collab_read_events(afterSeq) → collab_claim_task →
                  collab_complete_task；宿主每 8s 增量拉取同一事件流，MCP 写入会自动出现在时间线。
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/// 新建房间：成员、harness、模型、主导都在这里一次配完。
/// 只列可用 harness —— 选了不可用项会在第一次派单时失败，比在建房间时就挡住更晚也更难懂。
function RoomBuilderDialog({
  harnesses,
  initialMembers,
  initialName = '',
  title = '新建协作房间',
  submitLabel = '创建房间',
  onClose,
  onCreate,
}: {
  harnesses: CollabHarnessInfo[];
  /** 编辑态：成员的现有 id / harness / 模型 / 主导；空则按默认两位成员新建 */
  initialMembers?: CollabMemberInput[];
  initialName?: string;
  title?: string;
  submitLabel?: string;
  onClose: () => void;
  onCreate: (members: CollabMemberInput[], name: string) => void;
}) {
  // 编辑时把现有 harness 也保留在选项里（即便当前不可用），否则下拉显示会错位到第一项。
  const options = harnesses.filter(
    (harness) => harness.available || initialMembers?.some((member) => member.harnessId === harness.id),
  );
  const ids = options.map((harness) => harness.id);
  const pick = (...wanted: string[]) => wanted.find((id) => ids.includes(id)) ?? ids[0] ?? 'echo';
  const [name, setName] = useState(initialName);
  const [members, setMembers] = useState<CollabMemberInput[]>(() =>
    initialMembers?.length
      ? initialMembers.map((member) => ({ ...member }))
      : [
          { name: '主导', harnessId: pick('native', 'dsh'), model: '', lead: true },
          { name: '执行', harnessId: pick('dsh', 'mcp', 'native'), model: '' },
        ],
  );

  const update = (index: number, patch: Partial<CollabMemberInput>) => {
    setMembers((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  // 主导单选：同一时刻只有一个默认接单成员。
  const setLead = (index: number) => {
    setMembers((prev) => prev.map((item, i) => ({ ...item, lead: i === index })));
  };
  // 模型只对「按模型调用」的 harness 有意义；echo / mcp / 信箱的模型字段会被忽略。
  const usesModel = (harnessId: string) => ['native', 'dsh', 'acp'].includes(harnessId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-full rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-neutral-200 px-5 py-3 dark:border-stone-700">
          <Network size={18} className="text-indigo-600 dark:text-indigo-400" />
          <div>
            <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">{title}</div>
            <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500">
              成员各自选 harness 与模型；主导只是「默认接单」的那一位。
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-press ml-auto rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-stone-800"
            title="关闭"
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 p-5 text-xs">
          <label className="block">
            <span className="font-medium text-neutral-700 dark:text-stone-200">房间名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="留空则沿用默认名称"
              className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
            />
          </label>

          {members.map((member, index) => (
            <div
              key={index}
              className={`space-y-1.5 rounded-xl border p-3 ${
                member.lead
                  ? 'border-indigo-400/60 bg-indigo-500/5 dark:border-indigo-400/40'
                  : 'border-neutral-200 dark:border-stone-700'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  value={member.name ?? ''}
                  onChange={(event) => update(index, { name: event.target.value })}
                  placeholder={index === 0 ? '主导' : `成员${index + 1}`}
                  className="w-24 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
                />
                <select
                  value={member.harnessId}
                  onChange={(event) => {
                    const harnessId = event.target.value;
                    // 切到不用模型的 harness 时清空，避免把旧模型悄悄带进任务元数据。
                    update(index, usesModel(harnessId) ? { harnessId } : { harnessId, model: '' });
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
                >
                  {options.map((harness) => (
                    <option key={harness.id} value={harness.id}>
                      {harness.name}
                      {harness.available ? '' : ' · 不可用'}
                    </option>
                  ))}
                </select>
                <label
                  className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] ${
                    member.lead ? 'text-indigo-600 dark:text-indigo-400' : 'text-neutral-400 dark:text-stone-500'
                  }`}
                  title="主导：发消息不指定对象时的默认接单成员"
                >
                  <input
                    type="radio"
                    name="collab-lead"
                    checked={!!member.lead}
                    onChange={() => setLead(index)}
                    className="accent-indigo-600"
                  />
                  主导
                </label>
                {members.length > 2 && (
                  <button
                    onClick={() => setMembers((prev) => prev.filter((_, i) => i !== index))}
                    className="btn-press shrink-0 rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-stone-800"
                    title="移除该成员"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <input
                value={member.model ?? ''}
                onChange={(event) => update(index, { model: event.target.value })}
                disabled={!usesModel(member.harnessId)}
                placeholder={
                  usesModel(member.harnessId)
                    ? '成员模型：provider/model 或模型 id，留空跟随默认'
                    : '该 harness 不使用成员模型'
                }
                className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-400 disabled:opacity-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
              />
            </div>
          ))}

          <div className="text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500">
            任何成员都能当主导，没有优先级。自有 harness（安得云荟）与外部 harness（DeepSeek / MCP /
            信箱 / CLI）可以同室；外部成员的任务只入队或投递，由对方认领。
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() =>
                setMembers((prev) =>
                  prev.length >= 4
                    ? prev
                    : [...prev, { name: `成员${prev.length + 1}`, harnessId: pick('native', 'echo'), model: '' }],
                )
              }
              disabled={members.length >= 4}
              className="btn-press rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              + 添加成员
            </button>
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="btn-press rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                取消
              </button>
              <button
                onClick={() => onCreate(members, name)}
                className="btn-press rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                {submitLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const AiCollabView = memo(function AiCollabView({
  room,
  events,
  assignments,
  busy,
  error,
  onCreateRoom,
  onUpdateRoom,
  builderOpen,
  onOpenBuilder,
  onCloseBuilder,
  harnesses,
  deepseekAvailable,
  dshSessions,
  dshSessionsLoading,
  onLoadDshSessions,
  onImportDshSession,
  onSetWorkspace,
  onSend,
  onDemo,
  onCancel,
  permission,
  onReplyPermission,
}: AiCollabViewProps) {
  const [draft, setDraft] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  /** 本条消息派给谁；null = 跟随房间主导。 */
  const [targetId, setTargetId] = useState<string | null>(null);
  /** 房间呈现方式：列表（时间线）/ 画布（成员与任务流向）。默认列表，不影响原有使用习惯。 */
  const [view, setView] = useState<'list' | 'canvas'>('list');

  // 切房间时回到「派给主导」，避免把上一个房间的成员 id 带过来。
  useEffect(() => {
    setTargetId(null);
  }, [room?.id]);

  const importDialog = importOpen ? (
    <DshSessionImportDialog
      sessions={dshSessions}
      loading={dshSessionsLoading}
      onRefresh={onLoadDshSessions}
      onImport={(sessionId) => {
        onImportDshSession(sessionId);
        setImportOpen(false);
      }}
      onClose={() => setImportOpen(false)}
    />
  ) : null;

  // 新建房间弹窗在「空状态」和「已有房间」两个分支里都要能开：侧栏入口不区分有没有房间。
  const builder = builderOpen ? (
    <RoomBuilderDialog
      harnesses={harnesses ?? []}
      onClose={onCloseBuilder}
      onCreate={(members, name) => {
        onCreateRoom?.(members, name);
        onCloseBuilder();
      }}
    />
  ) : null;

  // 编辑态复用同一个弹窗：成员带原 id，后端据此保留任务归属与原生会话（模型没变时）。
  const editDialog = editOpen && room ? (
    <RoomBuilderDialog
      harnesses={harnesses ?? []}
      initialName={room.name}
      initialMembers={room.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        harnessId: agent.harnessId,
        model: agent.model ?? '',
        // 人设必须回填：不带回去保存时会被默认人设覆盖。
        persona: agent.persona ?? '',
        lead: agent.id === room.leadId,
      }))}
      title="编辑房间"
      submitLabel="保存"
      onClose={() => setEditOpen(false)}
      onCreate={(members, name) => {
        onUpdateRoom?.(room.id, members, name);
        setEditOpen(false);
      }}
    />
  ) : null;

  if (!room) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-hidden">
        <div className="max-w-md px-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <Users size={30} />
          </div>
          <h2 className="mt-4 text-lg font-bold text-indigo-600 dark:text-indigo-400">AI 协作</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-stone-400">
            把多个 harness agent 放进一个房间：分派任务、交换结果、统一管理。
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={onOpenBuilder}
              className="btn-press rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              新建房间
            </button>
            {deepseekAvailable && (
              <button
                onClick={() => {
                  setImportOpen(true);
                  onLoadDshSessions();
                }}
                className="btn-press rounded-full border border-neutral-300 px-5 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                导入 DeepSeek 会话
              </button>
            )}
            <button
              onClick={() => setMcpOpen(true)}
              className="btn-press rounded-full border border-indigo-500/40 bg-indigo-500/10 px-5 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-500/20 dark:text-indigo-300"
            >
              MCP 接入
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500">
            一个房间就是一组成员：每个成员选 harness 与模型，主导只是「默认接单」的那一位。
            外部成员（MCP / 信箱）的任务只入队或投递，由对方认领。
            <br />
            {deepseekAvailable
              ? 'DeepSeek 房间优先 ACP 原位恢复，失败回退 headless；事件同时镜像到项目的 .adyh/collab/。'
              : '未检测到 DeepSeek Harness；设置 ANDY_DSH_BIN 后可在成员里选它。'}
          </p>
        </div>
        {importDialog}
        {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
        {builder}
      </div>
    );
  }

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text, targetId ?? undefined);
    setDraft('');
  };

  // 派单对象：未选就是房间主导；切换后本条消息交给该成员。
  const target = room.agents.find((agent) => agent.id === targetId) ?? room.agents.find((agent) => agent.id === room.leadId);

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-neutral-200/70 px-5 py-3 dark:border-stone-700/60">
          <div className="flex items-center gap-2">
            <Network size={18} className="text-indigo-600 dark:text-indigo-400" />
            <span className="text-sm font-semibold text-neutral-800 dark:text-stone-100">{room.name}</span>
            <div className="ml-2 flex flex-wrap items-center gap-1">
              {room.agents.map((agent) => (
                <span
                  key={agent.id}
                  title={[agentMeta(agent), agent.persona].filter(Boolean).join(' · ')}
                  className="rounded-full border border-neutral-200 bg-white/60 px-2 py-0.5 text-[10px] text-neutral-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400"
                >
                  {agent.name}
                  {agent.id === room.leadId ? ' · 主导' : ''} · {agentMeta(agent)}
                </span>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center rounded-lg border border-neutral-300 p-0.5 dark:border-stone-600">
                {([['list', '列表'], ['canvas', '画布']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setView(key)}
                    className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                      view === key
                        ? 'bg-indigo-600 text-white'
                        : 'text-neutral-500 hover:bg-neutral-100 dark:text-stone-400 dark:hover:bg-stone-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setEditOpen(true)}
                title="编辑成员、模型与主导（保留历史）"
                className="btn-press flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                <Pencil size={14} />
                编辑
              </button>
              <button
                onClick={() => setMcpOpen(true)}
                title="查看 MCP 配置，让外部 harness 加入这个房间"
                className="btn-press flex items-center gap-1.5 rounded-lg border border-indigo-500/30 px-3 py-1.5 text-xs text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-400"
              >
                <Plug size={14} />
                MCP
              </button>
              <button
                onClick={async () => {
                  const dir = await invoke<string | null>('pick_directory').catch(() => null);
                  if (dir) onSetWorkspace(dir);
                }}
                title={room.workspace ? `工作目录：${room.workspace}` : '绑定工作目录，让其它 harness 扫描 .adyh/collab'}
                className="btn-press flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                <FolderOpen size={14} />
                {room.workspace ? '工作目录' : '绑定目录'}
              </button>
              {deepseekAvailable && (
                <button
                  onClick={() => {
                    setImportOpen(true);
                    onLoadDshSessions();
                  }}
                  className="btn-press flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
                >
                  <Download size={14} />
                  导入会话
                </button>
              )}
              <button
                onClick={onDemo}
                disabled={busy}
                className="btn-press flex items-center gap-1.5 rounded-lg border border-indigo-500/30 px-3 py-1.5 text-xs text-indigo-600 hover:bg-indigo-500/10 disabled:opacity-40 dark:text-indigo-400"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                运行协作演示
              </button>
            </div>
          </div>
          {(room.source?.kind === 'dsh-import'
            || room.agents.some((agent) => agent.nativeSessionId)
            || room.workspace) && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-neutral-400 dark:text-stone-500">
              <Download size={11} />
              {room.source?.kind === 'dsh-import'
                ? `导入自 DeepSeek Harness · ACP 原位恢复 · ${shortPath(room.workspace)}`
                : room.agents.some((agent) => agent.nativeSessionId)
                  ? `DeepSeek 原生会话 · ACP 连续续接${room.workspace ? ` · ${shortPath(room.workspace)}` : ''}`
                  : `共享目录 · ${shortPath(room.workspace)} · 已镜像到 .adyh/collab/`}
            </div>
          )}
        </header>

        {error && (
          <div className="mx-5 mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {view === 'canvas' ? (
          <CollabCanvas
            room={room}
            assignments={assignments}
            selectedId={target?.id ?? room.leadId}
            onSelect={(agentId) => setTargetId(agentId === room.leadId ? null : agentId)}
          />
        ) : (
          <Timeline room={room} events={events} />
        )}

        {permission && (
          <div className="mx-5 mb-1">
            {/* 与 Agent 工具审批共用同一个确认条组件，只是动作来自 ACP 选项。 */}
            <ApprovalBar
              title={`需要你确认：${permission.title}`}
              detail={`${permission.toolKind ? `类型：${permission.toolKind} · ` : ''}agent 正在等待你的选择，超时按拒绝处理。`}
              options={permission.options.map((option) => ({
                id: option.optionId,
                label: option.name,
              }))}
              onSelect={(optionId) => onReplyPermission?.(optionId)}
              onReject={() => onReplyPermission?.(null)}
            />
          </div>
        )}

        <footer className="shrink-0 border-t border-neutral-200/70 p-3 dark:border-stone-700/60">
          {/* 派单对象：混编房间里「发给谁」是一等公民，默认跟随主导。 */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-neutral-400 dark:text-stone-500">派给</span>
            {room.agents.map((agent) => {
              const selected = agent.id === (target?.id ?? room.leadId);
              return (
                <button
                  key={agent.id}
                  onClick={() => setTargetId(agent.id === room.leadId ? null : agent.id)}
                  title={agentMeta(agent)}
                  className={`btn-press rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                    selected
                      ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                      : 'border-neutral-200 text-neutral-500 hover:bg-neutral-100 dark:border-stone-700 dark:text-stone-400 dark:hover:bg-stone-800'
                  }`}
                >
                  {agent.name}
                  {agent.id === room.leadId ? ' · 主导' : ''}
                </button>
              );
            })}
          </div>
          <div className="flex items-end gap-2 rounded-2xl border border-neutral-200 bg-white px-3 py-2 shadow-sm focus-within:border-indigo-400/60 dark:border-stone-700 dark:bg-stone-800">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={
                target && target.id !== room.leadId
                  ? `发给「${target.name}」…`
                  : `发给主导「${target?.name ?? '成员'}」…`
              }
              className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-neutral-400 dark:text-stone-100 dark:placeholder:text-stone-500"
            />
            <button
              onClick={submit}
              disabled={!draft.trim() || busy}
              className="btn-press flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40"
              aria-label="发送"
            >
              <Send size={15} />
            </button>
          </div>
          <div className="mt-1.5 text-center text-[10px] text-neutral-400 dark:text-stone-500">
            任务派给所选成员并落盘；事件可重开回放，外部 harness 通过 MCP / 信箱接单
          </div>
        </footer>
      </div>

      <Board assignments={assignments} room={room} onCancel={onCancel} />
      {importDialog}
      {builder}
      {editDialog}
    </div>
  );
});

export default AiCollabView;
