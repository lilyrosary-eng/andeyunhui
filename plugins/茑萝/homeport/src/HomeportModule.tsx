/// <reference path="../../../global.d.ts" />
// 凌霄 · 下载中心主面板：任务列表 + 新建下载 + 引擎设置。

import type {
  DownloadTask,
  EngineConfig,
  EngineKind,
  EngineStatus,
  ProgressPayload,
  TaskDetail,
  TaskStatus,
} from './api';
import {
  dl,
  ENGINE_LABEL,
  STATUS_LABEL,
  formatBytes,
  formatSpeed,
  hostOf,
  isActiveStatus,
} from './api';
import { NewTaskPanel } from './NewTaskPanel';
import { TaskDetailPanel } from './TaskDetailPanel';
import { EngineSettings } from './EngineSettings';
import {
  AlertIcon,
  AnchorIcon,
  DownloadIcon,
  EmptyState,
  FolderIcon,
  IconButton,
  InfoIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ProgressBar,
  RefreshIcon,
  RetryIcon,
  SettingsIcon,
  StatusChip,
  TrashIcon,
  XIcon,
} from './ui';

const React = window.__HOST_REACT__;
const { useCallback, useEffect, useMemo, useRef, useState } = React;

type TaskView = DownloadTask & {
  speed?: number;
  partsDone?: number;
  partsTotal?: number;
};

type Filter = 'all' | 'active' | 'completed' | 'failed';

const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'probing', 'downloading', 'merging'];
const FILTER_ACTIVE = new Set<TaskStatus>([...ACTIVE_STATUSES, 'paused']);
const FILTER_FAILED = new Set<TaskStatus>(['failed', 'canceled']);

/** 完成/失败时的系统通知；权限未授予或环境不支持时静默跳过。 */
function notifyTask(task: DownloadTask) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const title = task.status === 'completed' ? '下载完成' : '下载失败';
    const body =
      task.status === 'failed' && task.error
        ? `${task.filename}\n${task.error}`
        : task.filename;
    const notification = new Notification(title, { body, tag: `homeport-${task.id}` });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        /* 忽略 */
      }
      notification.close();
    };
  } catch {
    /* 通知不可用时不影响下载 */
  }
}

export function HomeportModule() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [engines, setEngines] = useState<EngineStatus | null>(null);
  const [config, setConfig] = useState<EngineConfig | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'tasks' | 'settings'>('tasks');
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<Record<string, TaskStatus>>({});
  const notifyRef = useRef(true);

  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [list, engineStatus, engineConfig] = await Promise.all([
        dl.list(),
        dl.engines(),
        dl.configGet(),
      ]);
      setTasks((prev) => {
        const speeds = new Map(prev.map((task) => [task.id, task.speed ?? 0]));
        return list.map((task) => ({ ...task, speed: speeds.get(task.id) ?? 0 }));
      });
      // 记录当前状态作为通知基线：只有「事件里发生状态跃迁」才提醒，避免重载时补发。
      statusRef.current = Object.fromEntries(list.map((task) => [task.id, task.status]));
      setEngines(engineStatus);
      setConfig(engineConfig);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const refreshList = useCallback(async () => {
    const list = await dl.list();
    setTasks((prev) => {
      const speeds = new Map(prev.map((task) => [task.id, task.speed ?? 0]));
      return list.map((task) => ({ ...task, speed: speeds.get(task.id) ?? 0 }));
    });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    notifyRef.current = config?.notifyOnComplete ?? true;
  }, [config?.notifyOnComplete]);

  // 实时进度 / 状态事件；插件卸载时统一退订。
  useEffect(() => {
    let alive = true;
    const unsubs: Array<() => void> = [];
    const keep = (promise: Promise<() => void>) => {
      promise
        .then((un) => {
          if (alive) unsubs.push(un);
          else un();
        })
        .catch(() => {});
    };

    keep(
      window.__HOST_API__.listen<ProgressPayload>('download-kit:progress', ({ payload }) => {
        setTasks((prev) =>
          prev.map((task) =>
            task.id === payload.taskId
              ? {
                  ...task,
                  status: payload.status,
                  downloadedBytes: payload.downloaded,
                  totalBytes: payload.total || task.totalBytes,
                  speed: payload.speed,
                  connections: payload.connections,
                  error: payload.error ?? task.error,
                  partsDone: payload.partsDone,
                  partsTotal: payload.partsTotal,
                }
              : task,
          ),
        );
        setDetail((prev) =>
          prev && prev.id === payload.taskId
            ? {
                ...prev,
                status: payload.status,
                downloadedBytes: payload.downloaded,
                totalBytes: payload.total || prev.totalBytes,
                connections: payload.connections,
                error: payload.error ?? prev.error,
              }
            : prev,
        );
      }),
    );

    keep(
      window.__HOST_API__.listen<DownloadTask>('download-kit:state', ({ payload }) => {
        const previous = statusRef.current[payload.id];
        statusRef.current[payload.id] = payload.status;
        if (
          notifyRef.current &&
          previous &&
          previous !== payload.status &&
          (payload.status === 'completed' || payload.status === 'failed')
        ) {
          notifyTask(payload);
        }
        setTasks((prev) => {
          const index = prev.findIndex((task) => task.id === payload.id);
          if (index < 0) return [{ ...payload, speed: 0 }, ...prev];
          const next = [...prev];
          next[index] = {
            ...payload,
            speed: prev[index].speed ?? 0,
            partsDone: prev[index].partsDone,
            partsTotal: prev[index].partsTotal,
          };
          return next;
        });
        setDetail((prev) => (prev && prev.id === payload.id ? { ...prev, ...payload, parts: prev.parts } : prev));
      }),
    );

    return () => {
      alive = false;
      unsubs.forEach((un) => {
        try {
          un();
        } catch {
          /* 忽略 */
        }
      });
    };
  }, []);

  const hasActive = tasks.some((task) => ACTIVE_STATUSES.includes(task.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void refreshList().catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [hasActive, refreshList]);

  const counts = useMemo(
    () => ({
      all: tasks.length,
      active: tasks.filter((task) => FILTER_ACTIVE.has(task.status)).length,
      running: tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)).length,
      paused: tasks.filter((task) => task.status === 'paused').length,
      completed: tasks.filter((task) => task.status === 'completed').length,
      failed: tasks.filter((task) => FILTER_FAILED.has(task.status)).length,
    }),
    [tasks],
  );

  const filtered = useMemo(() => {
    if (filter === 'active') return tasks.filter((task) => FILTER_ACTIVE.has(task.status));
    if (filter === 'completed') return tasks.filter((task) => task.status === 'completed');
    if (filter === 'failed') return tasks.filter((task) => FILTER_FAILED.has(task.status));
    return tasks;
  }, [filter, tasks]);

  const totalSpeed = useMemo(
    () => tasks.reduce((sum, task) => sum + (ACTIVE_STATUSES.includes(task.status) ? task.speed ?? 0 : 0), 0),
    [tasks],
  );

  const engineName = (kind: EngineKind) =>
    engines?.engines.find((item) => item.kind === kind)?.name ?? ENGINE_LABEL[kind] ?? kind;

  const act = async (promise: Promise<unknown>) => {
    try {
      await promise;
      await refreshList();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const cancelTask = (task: TaskView) => {
    if (!window.confirm(`取消「${task.filename}」并删除未完成文件？`)) return;
    void act(dl.cancel(task.id, true));
  };

  const removeTask = async (task: TaskView) => {
    if (!window.confirm(`移除「${task.filename}」的任务记录？\n磁盘上的文件不会被删除。`)) return;
    try {
      await dl.forget(task.id);
      setDetail((prev) => (prev && prev.id === task.id ? null : prev));
      await refreshList();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const openTask = async (task: TaskView) => {
    try {
      await dl.openPath(task.savePath);
    } catch (err) {
      setError(String(err));
    }
  };

  const openDetail = async (task: TaskView) => {
    setShowNew(false);
    setDetailLoading(true);
    try {
      const full = await dl.get(task.id);
      setDetail(full);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const renderTask = (task: TaskView) => {
    const active = isActiveStatus(task.status);
    const paused = task.status === 'paused';
    const completed = task.status === 'completed';
    const failed = task.status === 'failed' || task.status === 'canceled';
    const percent = task.totalBytes > 0 ? Math.min(100, (task.downloadedBytes / task.totalBytes) * 100) : 0;
    const showProgress = active || paused || failed;

    return (
      <div
        key={task.id}
        className="rounded-2xl border border-black/5 bg-white/70 px-4 py-3.5 transition-colors hover:border-black/10 dark:border-white/5 dark:bg-stone-900/40 dark:hover:border-white/10"
      >
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${
              completed
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : failed
                  ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                  : 'bg-[var(--element-bg)]/10 text-[var(--element-color-raw)]'
            }`}
          >
            {completed ? <DownloadIcon size={17} /> : failed ? <AlertIcon size={17} /> : <AnchorIcon size={17} />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-neutral-800 dark:text-stone-100" title={task.filename}>
                {task.filename}
              </span>
              <StatusChip status={task.status} label={STATUS_LABEL[task.status]} />
              <span className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-white/10 dark:text-stone-400">
                {engineName(task.resolvedEngine ?? task.engine)}
              </span>
              {task.priority !== 0 ? (
                <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                  P{task.priority}
                </span>
              ) : null}
            </div>

            <div className="mt-0.5 truncate text-[11px] text-neutral-400 dark:text-stone-500" title={task.savePath}>
              {hostOf(task.urls[0] ?? '')} · {task.savePath}
            </div>

            {showProgress ? (
              <div className="mt-2 space-y-1">
                <ProgressBar downloaded={task.downloadedBytes} total={task.totalBytes} active={active} />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-neutral-400 dark:text-stone-500">
                  <span>
                    {formatBytes(task.downloadedBytes)}
                    {task.totalBytes > 0 ? ` / ${formatBytes(task.totalBytes)}` : ' / 未知'}
                    {task.totalBytes > 0 ? ` · ${percent.toFixed(1)}%` : ''}
                  </span>
                  {active ? <span>{formatSpeed(task.speed ?? 0)}</span> : null}
                  {active ? <span>{task.connections} 连接</span> : null}
                  {task.partsTotal ? (
                    <span>
                      分片 {task.partsDone ?? 0}/{task.partsTotal}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mt-1 text-[10px] text-neutral-400 dark:text-stone-500">
                {formatBytes(task.totalBytes)} · {new Date(task.completedAt ?? task.updatedAt).toLocaleString()}
              </div>
            )}

            {task.error ? (
              <div className="mt-1.5 rounded-lg bg-red-500/10 px-2 py-1 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
                {task.error}
              </div>
            ) : null}
          </div>

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <IconButton title="详情" disabled={detailLoading} onClick={() => void openDetail(task)}>
              <InfoIcon size={15} />
            </IconButton>
            {active ? (
              <IconButton title="暂停" onClick={() => void act(dl.pause(task.id))}>
                <PauseIcon size={15} />
              </IconButton>
            ) : null}
            {paused || failed ? (
              <IconButton
                title={failed ? '重试' : '继续'}
                onClick={() => void act(failed ? dl.retry(task.id) : dl.resume(task.id))}
              >
                {failed ? <RetryIcon size={15} /> : <PlayIcon size={15} />}
              </IconButton>
            ) : null}
            {completed ? (
              <IconButton title="打开文件" onClick={() => void openTask(task)}>
                <FolderIcon size={15} />
              </IconButton>
            ) : null}
            {!active && !paused ? (
              <IconButton title="移除记录（不删文件）" onClick={() => void removeTask(task)}>
                <TrashIcon size={15} />
              </IconButton>
            ) : null}
            {active || paused || task.status === 'queued' ? (
              <IconButton title="取消并清理" danger onClick={() => cancelTask(task)}>
                <XIcon size={15} />
              </IconButton>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const FILTERS: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: counts.all },
    { key: 'active', label: '进行中', count: counts.active },
    { key: 'completed', label: '已完成', count: counts.completed },
    { key: 'failed', label: '失败/取消', count: counts.failed },
  ];

  return (
    <div className="relative flex h-full flex-1 flex-col overflow-hidden bg-[#f5f5f0] text-neutral-800 dark:bg-[#1c1917] dark:text-stone-100">
      <div className="flex items-center gap-3 border-b border-black/5 px-6 pb-3 pt-5 dark:border-white/5">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--element-bg)]/10 text-[var(--element-color-raw)]">
          <AnchorIcon size={20} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">凌霄</h1>
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] text-neutral-500 dark:bg-white/10 dark:text-stone-400">
              下载中心
            </span>
          </div>
          <div className="text-[11px] text-neutral-400 dark:text-stone-500">
            多引擎 · 分片续传 · HLS · BT / 磁力 · 镜像与校验
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {counts.running > 0 ? (
            <button
              type="button"
              onClick={() => void act(dl.pauseAll())}
              className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium text-neutral-500 transition-colors hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
            >
              <PauseIcon size={14} />
              全部暂停
            </button>
          ) : null}
          {counts.paused > 0 ? (
            <button
              type="button"
              onClick={() => void act(dl.resumeAll())}
              className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium text-neutral-500 transition-colors hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
            >
              <PlayIcon size={14} />
              全部继续
            </button>
          ) : null}
          <IconButton title="刷新" onClick={() => void reload()}>
            <RefreshIcon size={15} className={loading ? 'animate-spin' : ''} />
          </IconButton>
          <button
            type="button"
            onClick={() => setView((value) => (value === 'settings' ? 'tasks' : 'settings'))}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
              view === 'settings'
                ? 'bg-black/10 text-neutral-700 dark:bg-white/15 dark:text-stone-100'
                : 'text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10'
            }`}
          >
            <SettingsIcon size={14} />
            引擎与设置
          </button>
          <button
            type="button"
            onClick={() => {
              setDetail(null);
              setShowNew(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--element-bg)] px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
          >
            <PlusIcon size={14} />
            新建下载
          </button>
        </div>
      </div>

      {view === 'tasks' ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2 text-[11px] text-neutral-400 dark:text-stone-500">
            <span className="inline-flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${hasActive ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-stone-600'}`} />
              进行中 {counts.active}
            </span>
            <span>总速度 {formatSpeed(totalSpeed)}</span>
            <span>已完成 {counts.completed}</span>
            <span className="ml-auto hidden sm:inline">支持 HTTP / HLS / BT / 磁力 / ed2k</span>
          </div>

          <div className="flex items-center gap-1 border-b border-black/5 px-6 dark:border-white/5">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={`relative px-3 py-2 text-xs font-medium transition-colors ${
                  filter === item.key
                    ? 'text-neutral-800 dark:text-stone-100'
                    : 'text-neutral-400 hover:text-neutral-600 dark:text-stone-500 dark:hover:text-stone-300'
                }`}
              >
                {item.label}
                <span className="ml-1 text-[10px] text-neutral-400 dark:text-stone-600">{item.count}</span>
                {filter === item.key ? (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--element-bg)]" />
                ) : null}
              </button>
            ))}
          </div>

          {error ? (
            <div className="mx-6 mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-600 dark:text-red-400">
              <AlertIcon size={14} className="mt-0.5 flex-shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
                <XIcon size={13} />
              </button>
            </div>
          ) : null}

          <div className="flex-1 space-y-2.5 overflow-y-auto px-6 py-4">
            {loading && tasks.length === 0 ? (
              <div className="py-16 text-center text-xs text-neutral-400 dark:text-stone-500">正在读取任务…</div>
            ) : filtered.length === 0 ? (
              <EmptyState
                title={filter === 'all' ? '还没有下载任务' : '这个分类是空的'}
                hint="点击右上角「新建下载」，粘贴直链、m3u8、磁力或 ed2k 链接。任务会持久化，重启后可以继续。"
              />
            ) : (
              filtered.map(renderTask)
            )}
          </div>
        </>
      ) : config ? (
        <EngineSettings
          config={config}
          engines={engines}
          onBack={() => setView('tasks')}
          onSaved={(next) => {
            setConfig(next);
            void reload(true);
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-neutral-400 dark:text-stone-500">
          正在读取引擎设置…
        </div>
      )}

      {showNew ? (
        <NewTaskPanel
          engines={engines}
          config={config}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            setFilter('all');
            void reload(true);
          }}
        />
      ) : null}

      {detail ? (
        <TaskDetailPanel
          detail={detail}
          engines={engines}
          onClose={() => setDetail(null)}
          onChanged={() => void openDetail(detail)}
        />
      ) : null}
    </div>
  );
}
