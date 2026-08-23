// AIWork（AIGC 专业模块 · 自包含工作台）· 任务区 = 对话工作台。
// 顶部只有一个「保存产出到产物库」动作；对话会话列表已并入共享侧栏（AiChatSidebar 任务区），
// 对话由宿主 Root 以独立 useAiChat 实例（AI_AIWORK_CONVERSATIONS_KEY）受控传入，与 AI 对话彻底隔离。
// 产物区（AiProductLibrary）在侧栏切到「产物区」时由宿主统一渲染，本组件不参与。
import { memo, useCallback, useMemo, useState } from 'react';
import { BookmarkCheck, Sparkles, Check } from 'lucide-react';
import { AiChatConversation } from './AiChatConversation';
import type { Conversation, SendAttachment } from '@/components/capsule/types';
import type { AiWorkProduct } from '@/core/ai/aiWorkProducts';

/** 最近一次产出（排除错误/空内容），供「保存到产物库」 */
function lastAssistantContent(conv: Conversation | null): string {
  if (!conv) return '';
  const found = [...conv.messages].reverse()
    .find((m) => m.role === 'assistant' && !m.speakerId && !m.error && !!m.content);
  return found?.content ?? '';
}

export interface AiWorkViewProps {
  profileId?: string;
  /** 产物库（用于计数展示），数据由宿主托管 */
  products: AiWorkProduct[];
  /** 保存一段产出到产物库（宿主托管） */
  onSaveOutput: (content: string, title?: string) => void;
  /** —— 受控 AIWork 对话 —— */
  activeConv: Conversation | null;
  busy: boolean;
  send: (text: string, images?: string[], attachments?: SendAttachment[]) => void;
  agent?: boolean;
  onToggleAgent?: (on: boolean) => void;
  conversations: Conversation[];
  onSelectConv: (id: string) => void;
  onNewConv: () => void;
  onDeleteConv: (id: string) => void;
  onRenameConv: (id: string, title: string) => void;
}

export const AiWorkView = memo(function AiWorkView({
  profileId,
  products,
  onSaveOutput,
  activeConv,
  busy,
  send,
  agent,
  onToggleAgent,
  conversations,
  onSelectConv,
  onNewConv,
  onDeleteConv,
  onRenameConv,
}: AiWorkViewProps) {
  const lastAi = useMemo(() => lastAssistantContent(activeConv), [activeConv]);
  const [saved, setSaved] = useState(false);

  const saveOutput = useCallback(() => {
    if (!lastAi) return;
    onSaveOutput(lastAi);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }, [lastAi, onSaveOutput]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* AIGC 工作台标题栏：独立模块标识 + 保存产出动作 */}
      <div className="shrink-0 flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-stone-700/60">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Sparkles size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">AIGC 工作台 · 对话任务区</div>
          <div className="truncate text-xs text-neutral-400 dark:text-stone-500">
            流式对话 + 历史回看，产出可一键存入专属产物库，与笔记无关
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {products.length > 0 && (
            <span className="text-[11px] text-neutral-400 dark:text-stone-500">产物库 {products.length} 份</span>
          )}
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

      <div className="min-h-0 flex-1">
        <AiChatConversation
          activeConv={activeConv}
          busy={busy}
          profileId={profileId || ''}
          send={send}
          agent={agent}
          onToggleAgent={onToggleAgent}
          conversations={conversations}
          onSelectConv={onSelectConv}
          onNewConv={onNewConv}
          onDeleteConv={onDeleteConv}
          onRenameConv={onRenameConv}
          emptyHint="输入 AIGC 需求，例如：写一个短视频脚本、拟一份活动文案"
        />
      </div>
    </div>
  );
});

AiWorkView.displayName = 'AiWorkView';

export default AiWorkView;