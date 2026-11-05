// AI 协作 · 房间视图（P1）。
//
// 只做「看得见的闭环」：房间成员、事件时间线、任务看板、运行演示。
// 不在这里做组态画布 —— 那是 P3 的事，先把任务分派与真实 harness 执行验证透。

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2, Clock, Copy, Download, FolderOpen, Loader2, Network, Play, Plug, Send, Square, Users,
  X, XCircle, type LucideIcon,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type {
  CollabAssignment, CollabAssignmentStatus, CollabEvent, CollabMcpInfo, CollabRoom, DshSessionSummary,
} from '@/core/ai/aiCollab';
import { DshSessionImportDialog } from '@/components/ai-chat/DshSessionImportDialog';

interface AiCollabViewProps {
  room: CollabRoom | null;
  events: CollabEvent[];
  assignments: CollabAssignment[];
  busy: boolean;
  error: string | null;
  onCreateRoom: () => void;
  /** 新建 DeepSeek Harness 房间；不可用时为空 */
  onCreateDeepSeekRoom?: () => void;
  /** 新建 MCP 房间：任务只入队，交给外部 harness 认领 */
  onCreateMcpRoom?: () => void;
  /** 新建 stream-json 房间（需要先配置 stream-json.json） */
  onCreateStreamJsonRoom?: () => void;
  streamJsonAvailable?: boolean;
  deepseekAvailable?: boolean;
  dshSessions: DshSessionSummary[];
  dshSessionsLoading: boolean;
  onLoadDshSessions: () => void;
  onImportDshSession: (sessionId: string) => void;
  onSetWorkspace: (workspace: string | null) => void;
  onSend: (text: string) => void;
  onDemo: () => void;
  onCancel: (assignmentId: string) => void;
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
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div ref={scroller} className="flex-1 min-w-0 overflow-y-auto px-5 py-4 space-y-3">
      {events.length === 0 && (
        <div className="flex h-full items-center justify-center text-xs text-neutral-400 dark:text-stone-500">
          还没有协作记录。发一条消息，或点「运行演示」。
        </div>
      )}
      {events.map((event) => {
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
          <div key={event.seq} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[78%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
              <span className="text-[10px] text-neutral-400 dark:text-stone-500">
                {isUser ? '我' : agentName(room, event.agentId)}
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
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-neutral-200/70 bg-neutral-50/60 dark:border-stone-700/60 dark:bg-stone-900/40 lg:flex">
      <div className="flex items-center gap-2 border-b border-neutral-200/70 px-4 py-3 text-xs font-semibold text-neutral-600 dark:border-stone-700/60 dark:text-stone-300">
        <Network size={14} />
        任务看板
        <span className="ml-auto text-[10px] font-normal text-neutral-400">{assignments.length}</span>
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

export const AiCollabView = memo(function AiCollabView({
  room,
  events,
  assignments,
  busy,
  error,
  onCreateRoom,
  onCreateDeepSeekRoom,
  onCreateMcpRoom,
  onCreateStreamJsonRoom,
  streamJsonAvailable,
  deepseekAvailable,
  dshSessions,
  dshSessionsLoading,
  onLoadDshSessions,
  onImportDshSession,
  onSetWorkspace,
  onSend,
  onDemo,
  onCancel,
}: AiCollabViewProps) {
  const [draft, setDraft] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);

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
              onClick={onCreateRoom}
              className="btn-press rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Echo 演示房间
            </button>
            {deepseekAvailable && onCreateDeepSeekRoom && (
              <button
                onClick={onCreateDeepSeekRoom}
                className="btn-press rounded-full border border-emerald-500/40 bg-emerald-500/10 px-5 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
              >
                DeepSeek 本地房间
              </button>
            )}
            {onCreateMcpRoom && (
              <button
                onClick={onCreateMcpRoom}
                className="btn-press rounded-full border border-sky-500/40 bg-sky-500/10 px-5 py-2 text-sm font-medium text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
              >
                MCP 协作房间
              </button>
            )}
            {streamJsonAvailable && onCreateStreamJsonRoom && (
              <button
                onClick={onCreateStreamJsonRoom}
                title="先编辑 ai-collab/stream-json.json 指定 CLI 命令"
                className="btn-press rounded-full border border-neutral-300 px-5 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                stream-json 房间
              </button>
            )}
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
            {deepseekAvailable
              ? 'DeepSeek 房间使用本机 LM Studio 小模型；导入会话优先 ACP 原位恢复，失败回退 headless，并镜像到项目的 .adyh/collab/。'
              : 'P2 未检测到 DeepSeek Harness；设置 ANDY_DSH_BIN 后可新建本地房间。'}
            <br />
            MCP 接入让 Trae / WorkBuddy 等外部 harness 直接读写同一份共享会话。
          </p>
        </div>
        {importDialog}
        {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
      </div>
    );
  }

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft('');
  };

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
                  title={agent.persona || agent.harnessId}
                  className="rounded-full border border-neutral-200 bg-white/60 px-2 py-0.5 text-[10px] text-neutral-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400"
                >
                  {agent.name}
                  {agent.id === room.leadId ? ' · lead' : ''} · {agent.harnessId}
                </span>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
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

        <Timeline room={room} events={events} />

        <footer className="shrink-0 border-t border-neutral-200/70 p-3 dark:border-stone-700/60">
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
              placeholder="发给主导成员，或点上方「运行协作演示」…"
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
            P0：未 @ 的消息交给 lead；任务与事件全部落盘，可重开回放
          </div>
        </footer>
      </div>

      <Board assignments={assignments} room={room} onCancel={onCancel} />
      {importDialog}
    </div>
  );
});

export default AiCollabView;
