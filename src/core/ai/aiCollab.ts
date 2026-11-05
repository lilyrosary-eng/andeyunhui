// AI 协作组态（P0）数据层。
//
// 这一层只做三件事：
// 1. 定义与 Rust `ai-collab-kit` 对齐的类型（serde camelCase）；
// 2. 管理房间快照 + 实时事件流（`collab-event`）；
// 3. 把「发消息 / 派单 / 演示 / 取消」包装成稳定 API，UI 不直接拼 invoke 字符串。
//
// 设计边界：P0 的事件是唯一事实源，任务表只是投影；UI 不缓存模型输出，
// 一律从事件回放。这样 P1 换成 ACP / CLI 时，前端不需要改数据模型。

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface CollabHarnessInfo {
  id: string;
  name: string;
  kind: string;
  available: boolean;
  detail: string;
}

export interface CollabAgent {
  id: string;
  name: string;
  harnessId: string;
  persona?: string;
  model?: string;
  /** 该成员绑定的 ACP 原生会话 id（每个成员独立） */
  nativeSessionId?: string | null;
}

export interface CollabRoomSource {
  kind: string;
  sessionId?: string | null;
}

export interface CollabRoom {
  id: string;
  name: string;
  leadId: string;
  agents: CollabAgent[];
  /** 绑定的工作目录；有值时事件流会镜像到该项目的 `.adyh/collab/` */
  workspace?: string | null;
  /** 导入来源；native 新建房间为 null */
  source?: CollabRoomSource | null;
  createdAt: number;
  updatedAt: number;
}

/** DeepSeek Harness 的持久会话摘要（只读导入用）。 */
export interface DshSessionSummary {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  format: string;
}

export type CollabAssignmentStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CollabAssignment {
  id: string;
  roomId: string;
  parentId?: string | null;
  assigneeId: string;
  brief: string;
  status: CollabAssignmentStatus;
  result?: string | null;
  /** 外部 harness 认领者标识（MCP 的 from） */
  claimedBy?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CollabEvent {
  seq: number;
  at: number;
  roomId: string;
  kind: string;
  agentId?: string | null;
  assignmentId?: string | null;
  text?: string | null;
  assignment?: CollabAssignment | null;
  data?: { role?: 'user' | 'agent' | 'system' } & Record<string, unknown>;
}

export interface CollabRoomSnapshot {
  room: CollabRoom;
  assignments: CollabAssignment[];
  events: CollabEvent[];
}

/** 启动恢复结果：上一进程遗留任务的处理统计。 */
export interface CollabRecovery {
  failedRunning: number;
  failedQueued: number;
  keptExternal: number;
}

/** MCP 控制面接入信息（`collab_mcp_info`）：给 Trae / WorkBuddy 等 harness 直接复制。 */
export interface CollabMcpInfo {
  root: string;
  binary: string | null;
  buildCommand: string;
  env: Record<string, string>;
  serverName: string;
  config: {
    mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  };
  tools: string[];
}

const EVENT_NAME = 'collab-event';

/** 事件按 seq 去重并保序：快照与实时流可能重叠。 */
function mergeEvent(list: CollabEvent[], event: CollabEvent): CollabEvent[] {
  if (list.some((item) => item.seq === event.seq)) return list;
  return [...list, event].sort((a, b) => a.seq - b.seq);
}

function upsertAssignment(list: CollabAssignment[], next: CollabAssignment): CollabAssignment[] {
  const index = list.findIndex((item) => item.id === next.id);
  if (index === -1) return [...list, next];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

export interface UseAiCollabResult {
  harnesses: CollabHarnessInfo[];
  rooms: CollabRoom[];
  activeRoom: CollabRoom | null;
  events: CollabEvent[];
  assignments: CollabAssignment[];
  busy: boolean;
  error: string | null;
  dshSessions: DshSessionSummary[];
  dshSessionsLoading: boolean;
  loadDshSessions: () => Promise<void>;
  importDshSession: (sessionId: string, name?: string) => Promise<void>;
  /** 绑定 / 解绑当前房间的工作目录（绑定后事件流镜像到项目 .adyh/collab） */
  setWorkspace: (workspace: string | null) => Promise<void>;
  createRoom: (name?: string, harnessId?: string) => Promise<void>;
  deleteRoom: (roomId: string) => Promise<void>;
  selectRoom: (roomId: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  assign: (assigneeId: string, brief: string) => Promise<void>;
  runDemo: () => Promise<void>;
  cancel: (assignmentId: string) => Promise<void>;
}

export function useAiCollab(): UseAiCollabResult {
  const [harnesses, setHarnesses] = useState<CollabHarnessInfo[]>([]);
  const [rooms, setRooms] = useState<CollabRoom[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<CollabRoom | null>(null);
  const [events, setEvents] = useState<CollabEvent[]>([]);
  const [assignments, setAssignments] = useState<CollabAssignment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dshSessions, setDshSessions] = useState<DshSessionSummary[]>([]);
  const [dshSessionsLoading, setDshSessionsLoading] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const activeRoomRef = useRef<CollabRoom | null>(null);
  activeRoomRef.current = activeRoom;
  /** 当前房间最后消费的事件序号：增量拉取与实时推送共用，避免重复合并。 */
  const lastSeqRef = useRef(0);

  const refreshRooms = useCallback(async () => {
    const list = await invoke<CollabRoom[]>('collab_room_list');
    setRooms(list);
    return list;
  }, []);

  const selectRoom = useCallback(async (roomId: string) => {
    setError(null);
    setActiveId(roomId);
    try {
      const snapshot = await invoke<CollabRoomSnapshot>('collab_room_snapshot', { roomId });
      const snapshotEvents = snapshot.events ?? [];
      setActiveRoom(snapshot.room);
      setEvents(snapshotEvents);
      setAssignments(snapshot.assignments ?? []);
      lastSeqRef.current = snapshotEvents.reduce((max, event) => Math.max(max, event.seq), 0);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // 初始加载：harness 目录 + 房间列表；有房间时自动选中第一个。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // 先恢复再读快照：否则上一进程遗留的 running 会一直显示为执行中。
        try {
          const recovery = await invoke<CollabRecovery>('collab_recover');
          if (recovery.failedRunning + recovery.failedQueued > 0) {
            console.info('[ai-collab] 已结束上次中断的任务:', recovery);
          }
        } catch {
          // 恢复失败不阻断房间加载；最坏情况是旧任务仍显示执行中。
        }
        const [catalog, list] = await Promise.all([
          invoke<CollabHarnessInfo[]>('collab_harnesses'),
          invoke<CollabRoom[]>('collab_room_list'),
        ]);
        if (!alive) return;
        setHarnesses(catalog);
        setRooms(list);
        if (list.length > 0) void selectRoom(list[0].id);
      } catch (err) {
        if (alive) setError(String(err));
      }
    })();
    return () => { alive = false; };
  }, [selectRoom]);

  // 实时事件：只接收当前房间，避免切房间时串流。
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    void listen<CollabEvent>(EVENT_NAME, (payload) => {
      const event = payload.payload;
      if (!event || event.roomId !== activeIdRef.current) return;
      lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
      setEvents((prev) => mergeEvent(prev, event));
      if (event.assignment) {
        const next = event.assignment;
        setAssignments((prev) => upsertAssignment(prev, next));
      }
      if (event.kind === 'room.updated') {
        const updated = event.data?.room as CollabRoom | undefined;
        if (updated) {
          setRooms((prev) => prev.map((room) => (room.id === updated.id ? updated : room)));
          if (updated.id === activeIdRef.current) setActiveRoom(updated);
        }
      }
      if (event.kind === 'assignment.completed' || event.kind === 'assignment.failed' || event.kind === 'assignment.cancelled') {
        setBusy(false);
      }
    }).then((off) => { unlisten = off; });
    return () => { unlisten?.(); };
  }, []);

  // 发现 dsh 既有会话：只在用户打开导入弹窗时扫描，避免启动即解压大量日志。
  const loadDshSessions = useCallback(async () => {
    setDshSessionsLoading(true);
    setError(null);
    try {
      const list = await invoke<DshSessionSummary[]>('collab_dsh_sessions');
      setDshSessions(list);
    } catch (err) {
      setError(String(err));
    } finally {
      setDshSessionsLoading(false);
    }
  }, []);

  const importDshSession = useCallback(async (sessionId: string, name?: string) => {
    setBusy(true);
    setError(null);
    try {
      const room = await invoke<CollabRoom>('collab_import_dsh_session', {
        sessionId,
        name: name?.trim() || null,
      });
      await refreshRooms();
      await selectRoom(room.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [refreshRooms, selectRoom]);

  // 外部 harness 通过 `<workspace>/.adyh/collab/rooms/<id>/inbox` 投递消息；
  // 与增量事件拉取一起每 8s 跑一次，自动把外部发言并入共享会话。
  // 未绑定 workspace 的房间没有 inbox 目录，这里直接返回 0。
  const syncExternal = useCallback(async () => {
    const roomId = activeIdRef.current;
    if (!roomId) return;
    try {
      const imported = await invoke<number>('collab_sync_external', { roomId });
      if (imported > 0) await selectRoom(roomId);
    } catch {
      // 外部同步失败不影响本应用内的对话。
    }
  }, [selectRoom]);

  // 增量拉取：MCP server / 其它进程写入的事件不会推送到本窗口，
  // 每 8s 用 afterSeq 补齐。与实时推送按 seq 去重，所以重复拉取没有副作用。
  const pollRoom = useCallback(async () => {
    const roomId = activeIdRef.current;
    if (!roomId) return;
    try {
      const incoming = await invoke<CollabEvent[]>('collab_events', {
        roomId,
        afterSeq: lastSeqRef.current,
      });
      if (!incoming?.length) return;
      lastSeqRef.current = incoming.reduce(
        (max, event) => Math.max(max, event.seq),
        lastSeqRef.current,
      );
      setEvents((prev) => {
        let next = prev;
        for (const event of incoming) next = mergeEvent(next, event);
        return next;
      });
      const updates = incoming
        .map((event) => event.assignment)
        .filter((assignment): assignment is CollabAssignment => !!assignment);
      if (updates.length > 0) {
        setAssignments((prev) => {
          let next = prev;
          for (const assignment of updates) next = upsertAssignment(next, assignment);
          return next;
        });
      }
      for (const event of incoming) {
        if (event.kind === 'room.updated') {
          const updated = event.data?.room as CollabRoom | undefined;
          if (updated) {
            setRooms((prev) => prev.map((room) => (room.id === updated.id ? updated : room)));
            if (updated.id === activeIdRef.current) setActiveRoom(updated);
          }
        }
        if (
          event.kind === 'assignment.completed'
          || event.kind === 'assignment.failed'
          || event.kind === 'assignment.cancelled'
        ) {
          setBusy(false);
        }
      }
    } catch {
      // 拉取失败不影响实时事件与本地操作。
    }
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const timer = window.setInterval(() => {
      void pollRoom();
      void syncExternal();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [activeId, pollRoom, syncExternal]);

  const setWorkspace = useCallback(async (workspace: string | null) => {
    const roomId = activeIdRef.current;
    if (!roomId) return;
    setError(null);
    try {
      const updated = await invoke<CollabRoom>('collab_set_room_workspace', {
        roomId,
        workspace,
      });
      setRooms((prev) => prev.map((room) => (room.id === updated.id ? updated : room)));
      setActiveRoom(updated);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const createRoom = useCallback(async (name?: string, harnessId = 'echo') => {
    setError(null);
    // 前端显式带成员，确保房间使用用户选中的 harness；后端仍保留默认 echo 兜底。
    const agents: CollabAgent[] = [
      {
        id: 'lead',
        name: '主导',
        harnessId,
        persona: '负责拆解任务、分派成员、汇总结果',
        model: '',
      },
      {
        id: 'worker',
        name: '执行',
        harnessId,
        persona: '负责执行被分派的子任务',
        model: '',
      },
    ];
    try {
      const fallbackName = harnessId === 'dsh'
        ? 'DeepSeek 本地协作'
        : harnessId === 'mcp'
          ? 'MCP 协作房间'
          : '协作房间';
      const room = await invoke<CollabRoom>('collab_room_create', {
        name: name?.trim() || fallbackName,
        agents,
        leadId: 'lead',
      });
      await refreshRooms();
      await selectRoom(room.id);
    } catch (err) {
      setError(String(err));
    }
  }, [refreshRooms, selectRoom]);

  const deleteRoom = useCallback(async (roomId: string) => {
    setError(null);
    try {
      await invoke('collab_room_delete', { roomId });
      const list = await refreshRooms();
      if (activeIdRef.current === roomId) {
        setActiveRoom(null);
        setEvents([]);
        setAssignments([]);
        setActiveId(null);
        if (list.length > 0) await selectRoom(list[0].id);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [refreshRooms, selectRoom]);

  /** 该成员是否由外部 harness 执行：这类任务只入队，不占用本应用的 busy 状态。 */
  const waitsForExternal = useCallback((agentId?: string) => {
    const room = activeRoomRef.current;
    if (!room) return false;
    const id = agentId ?? room.leadId;
    return room.agents.find((agent) => agent.id === id)?.harnessId === 'mcp';
  }, []);

  const send = useCallback(async (text: string) => {
    const roomId = activeIdRef.current;
    const body = text.trim();
    if (!roomId || !body) return;
    // MCP 房间的任务要等外部 harness 认领，锁住输入框只会让人以为卡住。
    const external = waitsForExternal();
    if (!external) setBusy(true);
    setError(null);
    try {
      await invoke('collab_room_send', { roomId, text: body });
    } catch (err) {
      if (!external) setBusy(false);
      setError(String(err));
    }
  }, [waitsForExternal]);

  const assign = useCallback(async (assigneeId: string, brief: string) => {
    const roomId = activeIdRef.current;
    if (!roomId || !brief.trim()) return;
    const external = waitsForExternal(assigneeId);
    if (!external) setBusy(true);
    setError(null);
    try {
      await invoke('collab_assign', {
        roomId,
        assigneeId,
        brief: brief.trim(),
        parentId: null,
      });
    } catch (err) {
      if (!external) setBusy(false);
      setError(String(err));
    }
  }, [waitsForExternal]);

  const runDemo = useCallback(async () => {
    const roomId = activeIdRef.current;
    if (!roomId) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('collab_demo', { roomId });
    } catch (err) {
      setBusy(false);
      setError(String(err));
    }
  }, []);

  const cancel = useCallback(async (assignmentId: string) => {
    const roomId = activeIdRef.current;
    if (!roomId) return;
    try {
      await invoke('collab_cancel', { roomId, assignmentId });
    } catch (err) {
      setError(String(err));
    }
  }, []);

  return {
    harnesses,
    rooms,
    activeRoom,
    events,
    assignments,
    busy,
    error,
    dshSessions,
    dshSessionsLoading,
    loadDshSessions,
    importDshSession,
    setWorkspace,
    createRoom,
    deleteRoom,
    selectRoom,
    send,
    assign,
    runDemo,
    cancel,
  };
}
