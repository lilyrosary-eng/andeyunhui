/// <reference path="../../../global.d.ts" />
// 攻防模块 · 操作审计日志
// 职责：记录所有攻防操作（扫描/Hook/注入/切换等），便于事后追溯，满足合规要求。
// 存储：localStorage（骨架阶段）；后续可迁移至 Rust 后端持久化日志文件。
// 约束：仅记录操作元信息（动作/目标/状态），不记录敏感明文（如 payload 原文、密钥）。
const React = window.__HOST_REACT__;
const { useState, useCallback, useEffect } = React;

const STORAGE_KEY = 'gongfang.audit.log';
const MAX_LOGS = 500; // 上限 500 条，超出自动裁剪旧记录

export type AuditStatus = 'info' | 'success' | 'warn' | 'error';

export interface AuditEntry {
  id: string;
  ts: number;          // 时间戳
  action: string;      // 动作（如 "端口扫描" / "切换框架"）
  target: string;      // 目标（如 "127.0.0.1:8080" / "审计抽屉"）
  status: AuditStatus; // 状态
  detail?: string;     // 可选备注（非敏感）
}

export interface AuditInput {
  action: string;
  target: string;
  status: AuditStatus;
  detail?: string;
}

// ============ 审计日志 Hook ============
export function useAuditLog() {
  const [logs, setLogs] = useState<AuditEntry[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as AuditEntry[]) : [];
    } catch {
      return [];
    }
  });

  // 持久化
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
    } catch {
      // 配额超限等异常：静默降级（不阻断主功能）
    }
  }, [logs]);

  const addLog = useCallback((input: AuditInput) => {
    const entry: AuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      action: input.action,
      target: input.target,
      status: input.status,
      detail: input.detail,
    };
    setLogs((prev) => {
      const next = [entry, ...prev];
      return next.length > MAX_LOGS ? next.slice(0, MAX_LOGS) : next;
    });
  }, []);

  const clearLog = useCallback(() => {
    setLogs([]);
  }, []);

  return { logs, addLog, clearLog };
}

// ============ 状态徽标 ============
function StatusBadge({ status }: { status: AuditStatus }) {
  const map: Record<AuditStatus, { cls: string; text: string }> = {
    info: { cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', text: '信息' },
    success: { cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', text: '成功' },
    warn: { cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', text: '警告' },
    error: { cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400', text: '错误' },
  };
  const v = map[status];
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${v.cls}`}>{v.text}</span>;
}

// ============ 审计日志抽屉 ============
export function AuditLogDrawer({ open, onClose, logs, onClear }: {
  open: boolean;
  onClose: () => void;
  logs: AuditEntry[];
  onClear: () => void;
}) {
  if (!open) return null;

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      {/* 抽屉 */}
      <div
        className="relative w-[420px] max-w-[90vw] h-full bg-[#fafaf7] dark:bg-[#1c1917] border-l border-black/10 dark:border-stone-700 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/10 dark:border-stone-700">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--element-bg)]">操作审计日志</span>
            <span className="text-xs text-neutral-400">{logs.length} 条</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClear}
              className="btn-press px-2 py-1 rounded text-xs text-rose-500 hover:bg-rose-500/10"
            >
              清空
            </button>
            <button
              onClick={onClose}
              className="btn-press px-2 py-1 rounded text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5"
            >
              关闭
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-neutral-400">
              暂无操作记录
            </div>
          ) : (
            <ul className="divide-y divide-black/5 dark:divide-stone-700/50">
              {logs.map((log) => (
                <li key={log.id} className="px-4 py-2.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusBadge status={log.status} />
                      <span className="text-sm text-[var(--element-bg)] truncate">{log.action}</span>
                    </div>
                    <span className="text-[10px] text-neutral-400 shrink-0">{fmtTime(log.ts)}</span>
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">
                    目标：{log.target}
                  </div>
                  {log.detail && (
                    <div className="text-[11px] text-neutral-400 mt-0.5 truncate">{log.detail}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 py-2 border-t border-black/10 dark:border-stone-700 text-[10px] text-neutral-400">
          日志仅本地存储，记录操作元信息，不含敏感明文。上限 {MAX_LOGS} 条。
        </div>
      </div>
    </div>
  );
}
