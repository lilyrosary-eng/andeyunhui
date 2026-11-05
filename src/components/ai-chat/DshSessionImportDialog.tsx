// 从 DeepSeek Harness 的持久会话里挑一个导入成共享协作房间。
//
// 这里只读会话摘要（标题 / 工作目录 / 更新时间），真正的 transcript 读取与导入在 Rust 侧完成；
// 避免前端解压大量 JSONL，也避免把 dsh 的存储格式泄漏到 UI。

import { memo } from 'react';
import { FolderOpen, Loader2, MessageSquare, RefreshCw, X } from 'lucide-react';
import type { DshSessionSummary } from '@/core/ai/aiCollab';

interface DshSessionImportDialogProps {
  sessions: DshSessionSummary[];
  loading: boolean;
  onRefresh: () => void;
  onImport: (sessionId: string) => void;
  onClose: () => void;
}

function shortPath(path: string): string {
  const value = path.trim();
  if (!value) return '（未知目录）';
  return value.length > 52 ? `…${value.slice(-50)}` : value;
}

export const DshSessionImportDialog = memo(function DshSessionImportDialog({
  sessions,
  loading,
  onRefresh,
  onImport,
  onClose,
}: DshSessionImportDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[72vh] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-5 py-3 dark:border-stone-700">
          <MessageSquare size={18} className="text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">导入 DeepSeek 会话</div>
            <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500">
              导入本身只读；导入后在该房间发言会通过 ACP 在原会话中继续（会追加到 dsh 原会话）。
            </div>
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="btn-press ml-auto rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            title="重新扫描"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
          <button
            onClick={onClose}
            className="btn-press rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            title="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          {loading && sessions.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-neutral-400 dark:text-stone-500">
              <Loader2 size={15} className="animate-spin" />
              正在扫描 dsh 会话…
            </div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="py-16 text-center text-xs leading-relaxed text-neutral-400 dark:text-stone-500">
              没有找到 DeepSeek Harness 会话。
              <br />
              先用 dsh 跑一次对话，或检查 `DSH_HOME` / `~/.dsh/sessions`。
            </div>
          )}
          <div className="space-y-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => onImport(session.id)}
                className="btn-press w-full rounded-xl border border-neutral-200/80 bg-white/70 px-3 py-2.5 text-left transition-colors hover:border-emerald-400/50 hover:bg-emerald-500/5 dark:border-stone-700/60 dark:bg-stone-800/50"
              >
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <FolderOpen size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-800 dark:text-stone-100">
                      {session.title || '未命名会话'}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-neutral-400 dark:text-stone-500" title={session.cwd}>
                      {shortPath(session.cwd)}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-400 dark:text-stone-500">
                      <span>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : '—'}</span>
                      <span className="rounded-full border border-neutral-200 px-1.5 py-0.5 dark:border-stone-700">
                        {session.format}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

export default DshSessionImportDialog;
