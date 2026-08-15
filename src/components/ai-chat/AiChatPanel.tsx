// 胶囊浮窗 · AI 对话紧凑面板 —— 复用 useAiChat 逻辑。
// 视觉与胶囊内「AI 编程 / 搜索」一致：深色玻璃底透出浮窗背景，半透明气泡 + 浅色文字（非全白）。
// 独立「AI 对话」模块不套此组件，改用 AiChatSidebar + AiChatConversation 双栏布局。
import { memo, useState } from 'react';
import { Bot, X, Send, Plus, ChevronDown, MessageSquare, Brain } from 'lucide-react';
import { ThinkingToggle } from '@/core/ai/ThinkingToggle';
import { useAiChat, DEFAULT_PERSIST_KEY } from './useAiChat';
import type { Conversation } from '@/components/capsule/types';

export interface AiChatPanelProps {
  persistKey?: string;
  systemPrompt?: string;
  coverUrl?: string | null;
  title?: string;
  emptyHint?: string;
  showKeepButton?: boolean;
  onKeepToggle?: (pinned: boolean) => void;
  keepPinned?: boolean;
  onClose?: () => void;
}

/** 胶囊气泡：思考过程可折叠（流式中强制展开，完成后默认收起，用户可手动切换）。 */
function CapsuleBubble({
  m,
  busy,
}: {
  m: Conversation['messages'][number];
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  // 流式（assistant 且 content 未出）强制展开，让用户看到思考进行中
  const streaming = busy && m.role === 'assistant' && !m.content;
  const show = streaming || open;
  return (
    <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${m.role === 'user' ? 'bg-amber-300/20 text-stone-100' : 'bg-white/10 text-stone-100'}`}>
        {m.reasoning && (
          <div className="mb-1.5 select-none">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 transition-colors"
            >
              <ChevronDown size={11} className={`transition-transform ${show ? '' : '-rotate-90'}`} />
              <Brain size={10} />
              <span className="italic">思考过程</span>
            </button>
            {show && (
              <div className="mt-1 text-[11px] text-stone-400 border-l-2 border-stone-500/50 pl-2 italic">
                {m.reasoning}
              </div>
            )}
          </div>
        )}
        {m.content || (streaming ? '…' : '')}
        {m.error && <span className="text-red-300">{m.content}</span>}
      </div>
    </div>
  );
}

export const AiChatPanel = memo(function AiChatPanel({
  persistKey = DEFAULT_PERSIST_KEY,
  systemPrompt,
  coverUrl,
  title = 'AI 对话',
  emptyHint,
  showKeepButton,
  onKeepToggle,
  keepPinned,
  onClose,
}: AiChatPanelProps) {
  const { conversations, activeId, activeConv, busy, profileId, selectConv, newConversation, send } = useAiChat({ persistKey, systemPrompt });
  const [input, setInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeMessages = activeConv?.messages ?? [];

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    void send(text);
    setInput('');
  };

  return (
    <div className="flex flex-col h-full text-stone-100">
      {/* 顶部：会话切换 + 操作 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="btn-press flex items-center gap-1.5 min-w-0 flex-1 px-2 py-1 rounded-lg hover:bg-white/10 transition-colors"
        >
          <MessageSquare size={15} className="text-amber-300/90 shrink-0" />
          <span className="text-sm font-medium truncate text-stone-100">{activeConv?.title || title}</span>
          <ChevronDown size={14} className="text-stone-400 shrink-0" />
        </button>
        <button
          onClick={() => newConversation()}
          title="新对话"
          className="btn-press w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
        >
          <Plus size={16} className="text-stone-300" />
        </button>
        {showKeepButton && onKeepToggle && (
          <button
            onClick={() => onKeepToggle(!keepPinned)}
            className="btn-press w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
            title={keepPinned ? '取消常驻' : '常驻胶囊'}
          >
            <Bot size={15} className={keepPinned ? 'text-amber-300' : 'text-stone-400'} />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="btn-press w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={16} className="text-stone-400" />
          </button>
        )}

        {pickerOpen && (
          <div className="absolute z-20 mt-1 left-3 right-3 top-11 max-h-48 overflow-y-auto rounded-xl border border-white/15 bg-black/80 backdrop-blur-md p-1 fade-in">
            {conversations.map((c: Conversation) => (
              <button
                key={c.id}
                onClick={() => { selectConv(c.id); setPickerOpen(false); }}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm truncate transition-colors ${c.id === activeId ? 'bg-amber-300/20 text-amber-200' : 'text-stone-200 hover:bg-white/10'}`}
              >
                {c.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 对话流 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {activeMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-stone-300/70 gap-2">
            {coverUrl && <img src={coverUrl} alt="" className="w-12 h-12 rounded-xl object-cover opacity-80" />}
            <p className="text-sm">{emptyHint || '问问 AI 任何事'}</p>
          </div>
        ) : (
          activeMessages.map((m) => (
            <CapsuleBubble key={m.id} m={m} busy={busy} />
          ))
        )}
      </div>

      {/* 思考开关 + 输入 */}
      <div className="border-t border-white/10 px-3 py-2">
        <div className="flex items-center justify-between mb-1.5">
          <ThinkingToggle compact profileId={profileId} />
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            rows={1}
            placeholder="发消息给 AI…"
            className="flex-1 resize-none max-h-24 min-h-[36px] rounded-xl bg-black/20 border border-white/15 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-400 outline-none focus:border-amber-300/40 transition-colors"
          />
          <button
            onClick={submit}
            disabled={busy || !input.trim()}
            className="btn-press w-9 h-9 flex items-center justify-center rounded-xl bg-amber-300/90 text-stone-900 disabled:opacity-40 transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
});

export default AiChatPanel;
