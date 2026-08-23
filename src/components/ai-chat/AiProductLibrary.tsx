// 共用「产物区」查看器 —— AIWork / AIWorkflow 复用。
// 读取宿主托管的 viewing 产物：查看 / 复制 / 导出 / 删除；无选中产物时显示空态引导。
// 产物列表在共享侧栏（AiChatSidebar），本组件只负责右侧查看区。
import { memo, useCallback, useState } from 'react';
import { FileText, Copy, Download, Check, BookmarkCheck } from 'lucide-react';
import type { AiWorkProduct } from '@/core/ai/aiWorkProducts';

export interface AiProductLibraryProps {
  /** 当前查看的产物（宿主托管）；为 null 时显示空态 */
  viewing: AiWorkProduct | null;
  onDelete: (id: string) => void;
}

export const AiProductLibrary = memo(function AiProductLibrary({
  viewing,
  onDelete,
}: AiProductLibraryProps) {
  const [copied, setCopied] = useState(false);

  const copyContent = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* 忽略 */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, []);

  const exportTxt = useCallback((p: AiWorkProduct) => {
    const blob = new Blob([p.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.title || 'ai产出'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  if (!viewing) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <BookmarkCheck size={28} className="opacity-70" />
        </div>
        <div className="text-sm font-medium text-neutral-700 dark:text-stone-200">还没有选中产物</div>
        <div className="mt-1 max-w-xs text-xs text-neutral-400 dark:text-stone-500">
          从左侧「专属产物库」点选一份产出即可在这里查看 / 复制 / 导出
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center gap-2 border-b border-neutral-200/60 px-5 py-3 dark:border-stone-700/60">
        <FileText size={15} className="text-sky-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-800 dark:text-stone-100">{viewing.title}</span>
        <button onClick={() => copyContent(viewing.content)} className="btn-press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/5">
          {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />} {copied ? '已复制' : '复制'}
        </button>
        <button onClick={() => exportTxt(viewing)} className="btn-press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/5">
          <Download size={13} /> 导出
        </button>
        <button
          onClick={() => onDelete(viewing.id)}
          className="btn-press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10"
          title="删除该产物"
        >
          <BookmarkCheck size={13} /> 删除
        </button>
        <button onClick={onGoTask} className="btn-press rounded-md p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300" title="返回任务区">
          <Download size={13} className="rotate-180" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-800 dark:text-stone-100">{viewing.content}</div>
      </div>
    </div>
  );
});

AiProductLibrary.displayName = 'AiProductLibrary';

export default AiProductLibrary;