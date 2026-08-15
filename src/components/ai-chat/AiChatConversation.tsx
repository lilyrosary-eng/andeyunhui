// 独立「AI 对话」模块 · 主区对话流 —— 大屏 UI，受控于上层共享的 useAiChat 实例。
// 不持有状态，仅负责把 messages + busy + send 渲染成对话界面（与浮窗紧凑版 UI 解耦）。
import { memo, useState } from 'react';
import { Send, Sparkles, Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { ThinkingToggle } from '@/core/ai/ThinkingToggle';
import type { Conversation } from '@/components/capsule/types';
import type { UseAiChatResult } from './useAiChat';
import { AiChatCompanionAvatar } from './AiChatCompanionCard';
import { useCompanionStore } from '@/mobile/stores/companionStore';
import { useUserAvatar } from './userAvatar';

/** 渲染用户头像：emoji 单字符居中；data:image/* 走 object-cover；其他用项目符号 */
function UserAvatarView({ value, size = 32 }: { value: string; size?: number }) {
  if (value.startsWith('data:image/')) {
    return (
      <img
        src={value}
        alt="你"
        style={{ height: size, width: size }}
        className="shrink-0 rounded-lg object-cover"
      />
    );
  }
  // emoji 走居中单字符；纯文本（如「你」）也走这里
  return (
    <div
      style={{ height: size, width: size, fontSize: size * 0.5 }}
      className="shrink-0 flex items-center justify-center rounded-lg bg-neutral-700 text-white leading-none dark:bg-stone-600"
    >
      <span className="leading-none">{value || '你'}</span>
    </div>
  );
}

export interface AiChatConversationProps {
  activeConv: Conversation | null;
  busy: boolean;
  profileId: string;
  send: (text: string) => void;
  onClear?: () => void;
  /** 启用伴侣时显示：默认 block 大卡片，compact 横版嵌入头部右侧 */
  companionCard?: React.ReactNode;
  /** 启用伴侣时把头部左圈占位图标换成伴侣头像 */
  showCompanionAvatar?: boolean;
}

export const AiChatConversation = memo(function AiChatConversation({
  activeConv,
  busy,
  profileId,
  send,
  onClear,
  companionCard,
  showCompanionAvatar,
}: AiChatConversationProps) {
  const [input, setInput] = useState('');
  // 思考展开状态：key = 消息 id。流式中（未填完 content）自动展开，用户也可手动切换。
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const messages = activeConv?.messages ?? [];
  const companion = useCompanionStore((s) => s.companion);
  const userAvatar = useUserAvatar();

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    send(text);
    setInput('');
  };

  // compact 形态的伴侣卡 absolute 居中嵌入头部；block 形态仍独占一行（备用）
  const compactCard = showCompanionAvatar ? companionCard : null;
  const blockCard = showCompanionAvatar ? null : companionCard;

  return (
    <div className="flex-1 h-full flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 头部：左圈标题左对齐、伴侣卡绝对居中叠加、清空按钮右贴边 */}
      <div className="relative flex items-center gap-3 px-6 h-14 border-b border-black/5 dark:border-white/5 flex-shrink-0">
        {showCompanionAvatar && companion ? (
          <AiChatCompanionAvatar companion={companion} size={32} />
        ) : (
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white shadow-sm">
            <Sparkles size={16} />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100 truncate">{activeConv?.title || 'AI 对话'}</div>
          <div className="text-[11px] text-neutral-400 dark:text-stone-500">{busy ? '正在思考…' : '由统一 AI 核心驱动'}</div>
        </div>
        {compactCard && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex-shrink-0 pointer-events-auto">
            {compactCard}
          </div>
        )}
        {!compactCard && onClear && (
          <button
            onClick={onClear}
            className="btn-press ml-auto text-xs px-3 py-1.5 rounded-lg text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            清空
          </button>
        )}
      </div>

      {/* block 形态伴侣卡（备用，启用伴侣 + 非 compact 时独占一行） */}
      {blockCard && (
        <div className="px-6 pt-3 flex-shrink-0">
          {blockCard}
        </div>
      )}

      {/* 对话流 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4 px-6">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white shadow-lg">
              <Sparkles size={28} />
            </div>
            <div>
              <p className="text-base font-medium text-neutral-700 dark:text-stone-200">开始一段新对话</p>
              <p className="text-sm text-neutral-400 dark:text-stone-500 mt-1">支持多轮上下文、思考过程展示与多会话管理</p>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
            {messages.map((m) => (
              <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`flex items-center justify-center flex-shrink-0 ${m.role === 'user' ? '' : 'shadow-sm'}`}>
                  {m.role === 'user' ? (
                    <UserAvatarView value={userAvatar} size={32} />
                  ) : showCompanionAvatar && companion ? (
                    <div className="rounded-full overflow-hidden shadow-sm ring-1 ring-black/5 dark:ring-white/10">
                      <AiChatCompanionAvatar companion={companion} size={32} />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white shadow-sm">
                      <Sparkles size={15} />
                    </div>
                  )}
                </div>
                <div className={`min-w-0 max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${m.role === 'user' ? 'bg-neutral-700 text-white dark:bg-stone-600' : 'bg-white/70 dark:bg-stone-800/70 text-neutral-800 dark:text-stone-100 shadow-sm border border-black/5 dark:border-white/5'}`}>
                  {m.reasoning && (() => {
                    // 流式输出（content 为空且忙碌）时强制展开，否则按用户折叠状态
                    const streaming = busy && m.role === 'assistant' && !m.content;
                    const open = streaming || !!reasoningOpen[m.id];
                    return (
                      <div className="mb-2 select-none">
                        <button
                          type="button"
                          onClick={() => setReasoningOpen((s) => ({ ...s, [m.id]: !open }))}
                          className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-stone-500 dark:hover:text-stone-300 transition-colors"
                        >
                          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <Brain size={11} />
                          <span className="italic">思考过程</span>
                        </button>
                        {open && (
                          <div className="mt-1 text-[12px] text-neutral-400 dark:text-stone-500 border-l-2 border-neutral-300 dark:border-stone-600 pl-2.5 py-0.5 italic whitespace-pre-wrap">
                            {m.reasoning}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {m.error ? (
                    <span className="text-red-500 dark:text-red-400">{m.content}</span>
                  ) : (
                    m.content || (busy && m.role === 'assistant' ? <span className="inline-flex gap-1 text-neutral-400"><span className="animate-pulse">●</span><span className="animate-pulse delay-150">●</span><span className="animate-pulse delay-300">●</span></span> : '')
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="border-t border-black/5 dark:border-white/5 px-6 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-3">
            <div className="flex-1 rounded-2xl bg-white/70 dark:bg-stone-800/70 border border-black/10 dark:border-white/10 px-4 py-2.5 focus-within:border-sky-400 transition-colors">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                }}
                rows={1}
                placeholder="发消息给 AI，Enter 发送，Shift+Enter 换行"
                className="w-full resize-none max-h-40 min-h-[24px] bg-transparent text-sm outline-none text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400"
              />
              <div className="flex items-center justify-between mt-1.5">
                <ThinkingToggle compact theme="light" profileId={profileId} />
                <span className="text-[11px] text-neutral-300 dark:text-stone-600">AI 可能出错，请核实重要信息</span>
              </div>
            </div>
            <button
              onClick={submit}
              disabled={busy || !input.trim()}
              className="btn-press w-11 h-11 flex items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 text-white shadow-sm disabled:opacity-40 transition-opacity"
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default AiChatConversation;
