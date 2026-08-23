// AIWork（AIGC 专业模块 · 自包含工作台）。
// 定位：独立的专业 AIGC 模块，产出物（文案/文档/表格/总结等）存独立产物库，
// 与笔记模块彻底解耦。对话状态使用独立 useAiChat 实例（独立 persistKey），
// 不复用根级 AI 对话的 useAiChat，实现完全隔离，互不串号。
import { memo, useCallback, useMemo, useState } from 'react';
import {
  FileText, BookmarkCheck, Loader2, Plus, Trash2, Copy, MessageSquare, Sparkles, Download, X, Check,
} from 'lucide-react';
import { AiChatConversation } from './AiChatConversation';
import { useAiChat } from '@/core/ai/useAiChat';
import { AI_AIWORK_CONVERSATIONS_KEY } from '@/core/ai/util';
import {
  loadProducts, addProduct, deleteProduct, type AiWorkProduct,
} from '@/core/ai/aiWorkProducts';

/** 最近一次产出（单人不算群聊成员拆分；排除错误/空内容），供「保存到产物库」 */
function lastAssistantContent(conv: import('@/components/capsule/types').Conversation | null): string {
  if (!conv) return '';
  const found = [...conv.messages].reverse()
    .find((m) => m.role === 'assistant' && !m.speakerId && !m.error && !!m.content);
  return found?.content ?? '';
}

export const AiWorkView = memo(function AiWorkView({
  profileId,
}: {
  profileId: string | undefined;
}) {
  // 独立对话实例：AIWork 专属 persistKey，与 AI 对话完全隔离
  const ai = useAiChat({ persistKey: AI_AIWORK_CONVERSATIONS_KEY });
  const activeConv = ai.activeConv;
  const lastAi = useMemo(() => lastAssistantContent(activeConv), [activeConv]);

  const [products, setProducts] = useState<AiWorkProduct[]>(() => loadProducts());
  const [saved, setSaved] = useState(false);
  const [viewing, setViewing] = useState<AiWorkProduct | null>(null);
  const [copied, setCopied] = useState(false);

  // 保存产出到产物库
  const saveOutput = useCallback(() => {
    if (!lastAi) return;
    addProduct(lastAi);
    setProducts(loadProducts());
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }, [lastAi]);

  const removeProduct = useCallback((id: string) => {
    deleteProduct(id);
    setProducts(loadProducts());
    setViewing((v) => (v && v.id === id ? null : v));
  }, []);

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

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* AIGC 工作台标题栏：独立模块标识 + 保存产出动作 */}
      <div className="shrink-0 flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-stone-700/60">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Sparkles size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">AIGC 工作台 · 独立专业模块</div>
          <div className="truncate text-xs text-neutral-400 dark:text-stone-500">
            {lastAi ? '对话产出可一键存入专属产物库，与笔记无关' : '独立对话 + 专属产物库，产出即存即用'}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            onClick={saveOutput}
            disabled={!lastAi}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-sky-500/40 px-3 py-1.5 text-xs font-medium text-sky-600 transition-colors hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-sky-400"
            title={lastAi ? '把当前最新 AI 产出存入专属产物库' : '还没有可保存的 AI 产出'}
          >
            {saved ? <Check size={14} className="text-emerald-500" /> : <BookmarkCheck size={14} />}
            {saved ? '已存入产物库' : '保存产出到产物库'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：独立产物库侧栏 */}
        <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200/60 dark:border-stone-700/60">
          <div className="shrink-0 flex items-center gap-2 px-4 py-3">
            <FileText size={15} className="text-neutral-400 dark:text-stone-500" />
            <span className="text-sm font-semibold text-neutral-700 dark:text-stone-200">专属产物库</span>
            <span className="ml-auto text-[11px] text-neutral-400 dark:text-stone-500">{products.length} 份</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {products.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <BookmarkCheck size={20} className="opacity-30" />
                <div className="text-xs text-neutral-400 dark:text-stone-500">还没有产出</div>
              </div>
            ) : (
              <div className="space-y-1">
                {products.map((p) => (
                  <div
                    key={p.id}
                    className={`group flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      viewing?.id === p.id
                        ? 'bg-sky-500/10'
                        : 'hover:bg-black/5 dark:hover:bg-white/5'
                    }`}
                    onClick={() => setViewing(p)}
                  >
                    <FileText size={14} className="mt-0.5 shrink-0 text-neutral-400 dark:text-stone-500" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-neutral-700 dark:text-stone-200">{p.title}</div>
                      <div className="text-[10px] text-neutral-400 dark:text-stone-500">
                        {new Date(p.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeProduct(p.id); }}
                      className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-opacity"
                      title="删除产物"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右：产物查看器 / 对话 */}
        <div className="min-w-0 flex-1">
          {viewing ? (
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
                <button onClick={() => setViewing(null)} className="btn-press rounded-md p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300" title="返回对话">
                  <X size={14} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-800 dark:text-stone-100">{viewing.content}</div>
              </div>
            </div>
          ) : (
            <AiChatConversation
              activeConv={activeConv}
              busy={ai.busy}
              profileId={profileId || ai.profileId}
              send={ai.send}
              agent={ai.agent}
              onToggleAgent={ai.setAgent}
              conversations={ai.conversations}
              onSelectConv={ai.selectConv}
              onNewConv={() => { ai.newConversation(); }}
              onDeleteConv={ai.deleteConversation}
              onRenameConv={ai.renameConversation}
              emptyHint="输入 AIGC 需求，例如：写一个短视频脚本、拟一份活动文案"
            />
          )}
        </div>
      </div>
    </div>
  );
});

AiWorkView.displayName = 'AiWorkView';

export default AiWorkView;