import { memo, useCallback, useMemo, useState } from 'react';
import { FileText, BookmarkCheck, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { AiChatConversation } from './AiChatConversation';
import type { Conversation } from '@/components/capsule/types';

/**
 * AIWork（AI 办公）一期工作台。
 * 定位：不是「更聪明的对话」，而是「聊完能落地成产出物」——成果物沉淀进现有笔记，
 * 形成「对话 → 文档/总结 → 存档复用」的闭环。
 *
 * 实现上完全复用现有 AI 对话核心（AiChatConversation + useAiChat），在其上增加：
 *   - 办公工作台标题栏（区别于普通对话，提示成果物属性）
 *   - 「落地到笔记」动作：把当前最新一条 AI 产出（非群聊、非错误）原子写进笔记库。
 */
interface AiWorkViewProps {
  activeConv: Conversation | null;
  busy: boolean;
  profileId: string;
  send: (text: string, images?: string[], attachments?: unknown[]) => void;
  onClear?: () => void;
  onOpenModuleSettings?: () => void;
  /** 胶囊形态透传：AIWork 不接胶囊，保留以对齐 AiChatConversation 类型签名 */
  capsuleMode?: boolean;
  conversations?: Conversation[];
  onSelectConv?: (id: string) => void;
  onNewConv?: () => void;
  onDeleteConv?: (id: string) => void;
  onRenameConv?: (id: string, title: string) => void;
  coverUrl?: string | null;
  agent?: boolean;
  onToggleAgent?: (on: boolean) => void;
}

/** 从内容取标题：优先会话标题，否则取最近用户消息前 24 字 */
function deriveTitle(conv: Conversation | null, lastAi: string): string {
  if (conv?.title && conv.title.trim()) return conv.title.trim();
  const userMsg = conv?.messages.filter((m) => m.role === 'user').slice(-1)[0]?.content;
  const src = userMsg || lastAi || '';
  const line = src.split('\n')[0]?.trim() || '';
  const first = [...line].slice(0, 24).join('');
  return first ? `成果摘要 · ${first}` : `办公成果 · ${new Date().toLocaleDateString()}`;
}

export const AiWorkView = memo(function AiWorkView({
  activeConv,
  busy,
  profileId,
  send,
  onClear,
  onOpenModuleSettings,
  capsuleMode = false,
  conversations = [],
  onSelectConv,
  onNewConv,
  onDeleteConv,
  onRenameConv,
  coverUrl = null,
  agent,
  onToggleAgent,
}: AiWorkViewProps) {
  // 最新一条 AI 产出（单人不算群聊成员拆分；排除错误/空内容）
  const lastAi = useMemo(() => {
    if (!activeConv) return null;
    const list = [...activeConv.messages].reverse();
    const found = list.find((m) => m.role === 'assistant' && !m.speakerId && !m.error && !!m.content);
    return found || null;
  }, [activeConv]);

  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<{ noteId: string; title: string } | null>(null);

  const commit = useCallback(async () => {
    if (!lastAi?.content || committing) return;
    setCommitting(true);
    setCommitted(null);
    try {
      const title = deriveTitle(activeConv, lastAi.content);
      const res = await invoke<{ noteId: string; title: string }>('aiwork_create_note', {
        title,
        content: lastAi.content,
      });
      setCommitted({ noteId: res.noteId, title: res.title });
    } catch (err) {
      console.error('[AiWork] 落地到笔记失败:', err);
    } finally {
      setCommitting(false);
    }
  }, [activeConv, lastAi, committing]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* 办公工作台标题栏：标识成果物属性 + 落地动作 */}
      <div className="shrink-0 flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-stone-700/60">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <FileText size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">AI 办公 · 成果物工作台</div>
            <div className="truncate text-xs text-neutral-400 dark:text-stone-500">
              对话产出可一键落地到笔记，形成「对话 → 文档 → 存档复用」闭环
            </div>
          </div>
        </div>
        <div className="ml-auto shrink-0">
          <button
            onClick={commit}
            disabled={committing || busy || !lastAi?.content}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-sky-500/40 px-3 py-1.5 text-xs font-medium text-sky-600 transition-colors hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-sky-400"
            title="把当前最新一条 AI 产出写入笔记"
          >
            {committing ? <Loader2 size={14} className="animate-spin" /> : <BookmarkCheck size={14} />}
            落地到笔记
          </button>
        </div>
      </div>

      {committed && (
        <div className="shrink-0 flex items-center gap-2 border-b border-green-500/30 bg-green-500/10 px-5 py-2 text-xs text-green-700 dark:text-green-400">
          <BookmarkCheck size={14} />
          已落地到笔记：《{committed.title}》
          <button
            onClick={() => setCommitted(null)}
            className="ml-auto text-green-600 underline-offset-2 hover:underline dark:text-green-500"
          >
            知道了
          </button>
        </div>
      )}

      {/* 复用现有对话主体（输入 / 粘贴附件 / 流式渲染） */}
      <div className="relative flex-1 min-h-0">
        <AiChatConversation
          activeConv={activeConv}
          busy={busy}
          profileId={profileId}
          send={send}
          onClear={onClear}
          agent={agent}
          onToggleAgent={onToggleAgent}
          capsuleMode={capsuleMode}
          conversations={conversations}
          onSelectConv={onSelectConv}
          onNewConv={onNewConv}
          onDeleteConv={onDeleteConv}
          onRenameConv={onRenameConv}
          coverUrl={coverUrl}
          emptyHint="输入办公需求，例如：帮我写一份本周工作总结"
        />
      </div>
    </div>
  );
});

AiWorkView.displayName = 'AiWorkView';