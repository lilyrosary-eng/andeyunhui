// 独立「AI 对话」模块 · 主区对话流 —— 大屏 UI，受控于上层共享的 useAiChat 实例。
// 不持有状态，仅负责把 messages + busy + send 渲染成对话界面（与浮窗紧凑版 UI 解耦）。
import { memo, useEffect, useState } from 'react';
import { Send, Sparkles, Brain, ChevronDown, ChevronRight, MessageSquare, Pencil, Trash2, Plus, X, Pin, Paperclip, FileText, File as FileIcon } from 'lucide-react';
import { ThinkingToggle } from '@/core/ai/ThinkingToggle';
import type { Conversation, SendAttachment, AttachmentKind } from '@/components/capsule/types';
import type { UseAiChatResult } from '@/core/ai/useAiChat';
import { AiChatCompanionAvatar } from './AiChatCompanionCard';
import { useCompanionStore } from '@/core/stores/companionStore';
import { useUserAvatar } from '@/core/avatar/userAvatar';
import { renderMarkdown, injectMarkdownStyles, attachMarkdownCopyHandler } from '@/lib/markdown';
import { UsageMeter } from '@/components/bricks/UsageMeter';

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

// ---- 附件拾取（粘贴 + 导入）+ 分类 ----
interface Picked {
  kind: AttachmentKind;
  name: string;
  mime: string;
  size?: number;
  /** 图片：dataUrl，用于缩略图展示 + 发送时 OCR */
  dataUrl?: string;
  /** text 附件：读取到的文本内容（发送时注入，之后丢弃，不落库） */
  text?: string;
}

/** 文本类文件扩展名白名单：命中即读内容给 AI；否则仅陈列文件名 */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'js', 'jsx', 'ts', 'tsx', 'vue',
  'py', 'c', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'sql', 'css', 'scss', 'html', 'xml',
  'csv', 'tsv', 'gitignore', 'dockerfile', 'editorconfig', 'cls',
]);
/** 文本附件内容上限（超过则降级为仅陈列，避免超大文本注入烧 token） */
const MAX_TEXT_BYTES = 200 * 1024;
/** 图片最多 3 张；附件总数上限 */
const MAX_IMG = 3;
const MAX_PICKED = 12;

function isTextLike(f: { name: string; type: string }): boolean {
  if (f.type.startsWith('text/')) return true;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return TEXT_EXTS.has(ext);
}

export interface AiChatConversationProps {
  activeConv: Conversation | null;
  busy: boolean;
  profileId: string;
  send: (text: string, images?: string[], attachments?: SendAttachment[]) => void;
  onClear?: () => void;
  /** 启用伴侣时显示：默认 block 大卡片，compact 横版嵌入头部右侧 */
  companionCard?: React.ReactNode;
  /** 启用伴侣时把头部左圈占位图标换成伴侣头像 */
  showCompanionAvatar?: boolean;
  /**
   * 胶囊形态：复用同一套主体，仅切深色玻璃皮肤 + 顶栏换成胶囊样式（关闭/保持/内嵌会话下拉），
   * 关闭群聊入口（群聊不对胶囊开放）。胶囊不渲染独立侧栏，会话切换走内嵌下拉。
   */
  capsuleMode?: boolean;
  conversations?: Conversation[];
  onSelectConv?: (id: string) => void;
  onNewConv?: () => void;
  onDeleteConv?: (id: string) => void;
  onRenameConv?: (id: string, title: string) => void;
  coverUrl?: string | null;
  showKeepButton?: boolean;
  keepPinned?: boolean;
  onKeepToggle?: (pinned: boolean) => void;
  onClose?: () => void;
  emptyHint?: string;
  /** Agent 工具模式（联网/工具）。true=走 ai_chat_agent，false=纯对话。 */
  agent?: boolean;
  onToggleAgent?: (on: boolean) => void;
}

export const AiChatConversation = memo(function AiChatConversation({
  activeConv,
  busy,
  profileId,
  send,
  onClear,
  companionCard,
  showCompanionAvatar,
  capsuleMode = false,
  conversations = [],
  onSelectConv,
  onNewConv,
  onDeleteConv,
  onRenameConv,
  coverUrl = null,
  showKeepButton = false,
  keepPinned = false,
  onKeepToggle,
  onClose,
  emptyHint,
  agent = false,
  onToggleAgent,
}: AiChatConversationProps) {
  const [input, setInput] = useState('');
  // 待发送附件（图片 / 文本 / 其它文件），仅在点击发送前暂存，发送后清空。
  // 图片走 dataUrl(缩略图+OCR)；文本读内容注入；其它文件仅陈列文件名。dataUrl/text 不落库。
  const [picked, setPicked] = useState<Picked[]>([]);
  // 思考展开状态：key = 消息 id。流式中（未填完 content）自动展开，用户也可手动切换。
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  // 胶囊内嵌会话下拉开关
  const [pickerOpen, setPickerOpen] = useState(false);
  // 后端 ai_chat 安全截断提示（messages 过长被自动裁剪）
  const [truncateWarn, setTruncateWarn] = useState<{ kept: number } | null>(null);
  const messages = activeConv?.messages ?? [];
  const companion = useCompanionStore((s) => s.companion);
  const userAvatar = useUserAvatar();

  // 共享 markdown 样式 + 代码块复制按钮（幂等挂一次）
  useEffect(() => {
    injectMarkdownStyles();
    return attachMarkdownCopyHandler();
  }, []);

  // 监听后端 ai_chat 安全截断事件：messages 过长被自动裁剪时弹轻提示（主窗口形态才提示）
  useEffect(() => {
    if (capsuleMode) return; // 胶囊有自己的 UI，不在此弹
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ kind: string; kept?: number }>('ai-warn', (e) => {
          if (e.payload.kind !== 'messages_truncated') return;
          setTruncateWarn({ kept: e.payload.kept ?? 0 });
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => setTruncateWarn(null), 4000);
        }),
      )
      .then((u) => (unlisten = u));
    return () => {
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [capsuleMode]);

  const submit = () => {
    const text = input.trim();
    if ((!text && picked.length === 0) || busy) return;
    // 图片单独走 images（发送时 OCR 注入）；非图片走 attachments（文本注入/文件陈列）
    const images = picked.filter((p) => p.kind === 'image').map((p) => p.dataUrl || '');
    const attachments: SendAttachment[] = picked
      .filter((p) => p.kind !== 'image')
      .map(({ kind, name, mime, size, text }) => ({ kind, name, mime, size, text }));
    send(text || '（附件）', images, attachments);
    setInput('');
    setPicked([]);
  };

  // 追加一项附件（带图片/总数上限）
  const addPicked = (item: Picked) => {
    setPicked((prev) => {
      if (prev.length >= MAX_PICKED) return prev;
      if (item.kind === 'image' && prev.filter((p) => p.kind === 'image').length >= MAX_IMG) return prev;
      return [...prev, item];
    });
  };

  // 解析一批 File 进附件列表：图片(限 3 张)转 dataUrl、文本(限大小)读内容、其它仅陈列
  const intoPicked = (files: File[]) => {
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const url = typeof reader.result === 'string' ? reader.result : '';
          if (url) addPicked({ kind: 'image', name: f.name, mime: f.type, size: f.size, dataUrl: url });
        };
        reader.readAsDataURL(f);
      } else if (isTextLike(f) && (f.size ?? 0) <= MAX_TEXT_BYTES) {
        const reader = new FileReader();
        reader.onload = () => {
          const txt = typeof reader.result === 'string' ? reader.result : '';
          if (txt) addPicked({ kind: 'text', name: f.name, mime: f.type, size: f.size, text: txt });
        };
        reader.readAsText(f, 'utf-8');
      } else {
        // 其它（含超大文本/二进制）：仅陈列文件名
        addPicked({ kind: 'file', name: f.name, mime: f.type || 'application/octet-stream', size: f.size });
      }
    }
  };

  // 粘贴：图片 / 文件直接拾取；纯文本默认进 textarea
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const items = Array.from(cd.items || []);
    const imgItem = items.find((i) => i.kind === 'file' && i.type && i.type.startsWith('image/'));
    const files = Array.from(cd.files || []);
    // 有图片或文件时阻止默认（避免把图片/文件二进制文本塞进输入框）
    if (imgItem || files.length) {
      e.preventDefault();
      const pickedFiles: File[] = [];
      if (imgItem) { const f = imgItem.getAsFile(); if (f) pickedFiles.push(f); }
      for (const f of files) { if (!(f.type.startsWith('image/') && imgItem)) pickedFiles.push(f); }
      intoPicked(pickedFiles);
    }
  };

  // compact 形态的伴侣卡 absolute 居中嵌入头部；block 形态仍独占一行（备用）
  const compactCard = showCompanionAvatar ? companionCard : null;
  const blockCard = showCompanionAvatar ? null : companionCard;

  // 胶囊形态：深色玻璃皮肤；主窗口形态：原浅色
  const shellClass = capsuleMode
    ? 'flex-1 h-full flex flex-col bg-black/20 backdrop-blur-xl text-white/90'
    : 'flex-1 h-full flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917]';
  const borderCls = capsuleMode ? 'border-white/10' : 'border-black/5 dark:border-white/5';
  const mutedCls = capsuleMode ? 'text-white/50' : 'text-neutral-400 dark:text-stone-500';
  const bubbleCls = capsuleMode
    ? (mRole: 'user' | 'assistant') =>
        mRole === 'user'
          ? 'bg-white/15 text-white'
          : 'bg-white/10 text-white/90 shadow-sm border border-white/10'
    : (mRole: 'user' | 'assistant') =>
        mRole === 'user'
          ? 'bg-neutral-700 text-white dark:bg-stone-600'
          : 'bg-white/70 dark:bg-stone-800/70 text-neutral-800 dark:text-stone-100 shadow-sm border border-black/5 dark:border-white/5';
  const inputWrapCls = capsuleMode
    ? 'bg-white/10 border-white/15 text-white placeholder:text-white/40'
    : 'bg-white/70 dark:bg-stone-800/70 border-black/10 dark:border-white/10 text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400';
  const sendBtnCls = capsuleMode
    ? 'bg-white/20 text-white disabled:opacity-40'
    : 'bg-gradient-to-br from-sky-400 to-indigo-500 text-white shadow-sm disabled:opacity-40';

  return (
    <div className={shellClass}>
      {/* 后端安全截断提示：messages 过长被自动裁剪时短暂显示 */}
      {truncateWarn && (
        <div className="flex items-center gap-2 px-6 py-2 text-[12px] bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-b border-amber-200 dark:border-amber-800/50 flex-shrink-0">
          <span>⚠ 对话历史过长，已自动截断保留最近部分（约 {truncateWarn.kept} 条），长上下文已归档至记忆。</span>
          <button
            onClick={() => setTruncateWarn(null)}
            className="ml-auto text-amber-500 hover:text-amber-700 dark:hover:text-amber-200"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}
      {/* 头部：主窗口=标题+清空+设置；胶囊=会话下拉+关闭/保持 */}
      {capsuleMode ? (
        <div className={`relative flex items-center gap-2 px-3 h-12 ${borderCls} border-b flex-shrink-0`}>
          <div className="relative">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-white/10 transition-colors text-sm"
            >
              <MessageSquare size={15} />
              <span className="max-w-[120px] truncate">{activeConv?.title || '新对话'}</span>
              <ChevronDown size={13} />
            </button>
            {pickerOpen && (
              <div className="absolute left-0 top-full mt-1 w-56 max-h-72 overflow-y-auto rounded-xl bg-stone-800/95 backdrop-blur-xl border border-white/10 shadow-2xl py-1 z-30">
                {conversations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { onSelectConv?.(c.id); setPickerOpen(false); }}
                    className={`flex items-center justify-between w-full px-3 py-1.5 text-left text-sm hover:bg-white/10 ${c.id === activeConv?.id ? 'text-white' : 'text-white/70'}`}
                  >
                    <span className="truncate max-w-[140px]">{c.title || '新对话'}</span>
                    <span className="flex items-center gap-1 ml-2" onClick={(e) => e.stopPropagation()}>
                      <span
                        role="button"
                        onClick={() => {
                          const next = window.prompt('重命名对话', c.title);
                          if (next !== null) onRenameConv?.(c.id, next);
                        }}
                        className="opacity-60 hover:opacity-100"
                      >
                        <Pencil size={12} />
                      </span>
                      <span
                        role="button"
                        onClick={() => onDeleteConv?.(c.id)}
                        className="opacity-60 hover:opacity-100 text-red-400"
                      >
                        <Trash2 size={12} />
                      </span>
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => { onNewConv?.(); setPickerOpen(false); }}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left text-sm text-white/70 hover:bg-white/10 border-t border-white/10 mt-1"
                >
                  <Plus size={13} /> 新对话
                </button>
              </div>
            )}
          </div>
          {showKeepButton && (
            <button
              onClick={() => onKeepToggle?.(!keepPinned)}
              className={`btn-press ml-auto p-1.5 rounded-lg hover:bg-white/10 transition-colors ${keepPinned ? 'text-sky-300' : 'text-white/60'}`}
              title={keepPinned ? '取消保持打开' : '保持打开'}
            >
              <Pin size={15} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="btn-press p-1.5 rounded-lg hover:bg-white/10 transition-colors text-white/60"
              title="关闭"
            >
              <X size={16} />
            </button>
          )}
        </div>
      ) : (
        <div className={`relative flex items-center gap-3 px-6 h-14 ${borderCls} border-b flex-shrink-0`}>
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
        {!compactCard && (
          <div className="ml-auto flex items-center gap-2">
            {!capsuleMode && <UsageMeter />}
            {onClear && (
              <button
                onClick={onClear}
                className="btn-press text-xs px-3 py-1.5 rounded-lg text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                清空
              </button>
            )}
          </div>
        )}
      </div>
      )}

      {/* 群聊信息条：参与者头像组 + 成本提示（不暴露 severity / 争论 / 调侃，维持沉浸感） */}
      {activeConv?.mode === 'group' && (() => {
        const companionsAll = useCompanionStore.getState().collection.companions;
        const members = (activeConv.participants ?? [])
          .map((id) => companionsAll.find((c) => c.id === id))
          .filter(Boolean) as typeof companionsAll;
        const calls = activeConv.groupCost?.calls ?? 0;
        return (
          <div className="flex items-center gap-3 px-6 py-2 border-b border-black/5 dark:border-white/5 bg-black/[0.015] dark:bg-white/[0.02] flex-shrink-0">
            <div className="flex -space-x-2">
              {members.map((c) => (
                <div key={c.id} className="rounded-full overflow-hidden ring-2 ring-[#f5f5f0] dark:ring-[#1c1917]">
                  <AiChatCompanionAvatar companion={c} size={26} />
                </div>
              ))}
            </div>
            <span className="text-[11px] text-neutral-400 dark:text-stone-500">
              {members.length} 位伴侣一起聊 · 本次已调用 {calls} 次 AI
            </span>
          </div>
        );
      })()}

      {/* block 形态伴侣卡（备用，启用伴侣 + 非 compact 时独占一行） */}
      {blockCard && (
        <div className="px-6 pt-3 flex-shrink-0">
          {blockCard}
        </div>
      )}

      {/* 对话流（胶囊形态可选封面 coverUrl） */}
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        {capsuleMode && coverUrl ? (
          <>
            <img src={coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none" />
            <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black/50 pointer-events-none" />
          </>
        ) : null}
        <div className="relative h-full">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4 px-6">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white shadow-lg">
              <Sparkles size={28} />
            </div>
            <div>
              <p className="text-base font-medium text-neutral-700 dark:text-stone-200">{emptyHint || '开始一段新对话'}</p>
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
                  ) : activeConv?.mode === 'group' && m.speakerId ? (() => {
                    const speaker = useCompanionStore.getState().collection.companions.find((c) => c.id === m.speakerId);
                    return speaker ? (
                      <div className="rounded-full overflow-hidden shadow-sm ring-1 ring-black/5 dark:ring-white/10">
                        <AiChatCompanionAvatar companion={speaker} size={32} />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white shadow-sm">
                        <Sparkles size={15} />
                      </div>
                    );
                  })() : showCompanionAvatar && companion ? (
                    <div className="rounded-full overflow-hidden shadow-sm ring-1 ring-black/5 dark:ring-white/10">
                      <AiChatCompanionAvatar companion={companion} size={32} />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white shadow-sm">
                      <Sparkles size={15} />
                    </div>
                  )}
                </div>
                <div className={`min-w-0 max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words ${bubbleCls(m.role)}`}>
                  {m.role === 'assistant' && activeConv?.mode === 'group' && m.speakerId && (() => {
                    const speaker = useCompanionStore.getState().collection.companions.find((c) => c.id === m.speakerId);
                    return speaker ? (
                      <div className="text-[11px] font-medium text-neutral-400 dark:text-stone-500 mb-1">{speaker.name}</div>
                    ) : null;
                  })()}
                  {m.reasoning && (() => {
                    // 流式输出（content 为空且忙碌）时强制展开，否则按用户折叠状态
                    const streaming = busy && m.role === 'assistant' && !m.content;
                    const open = streaming || !!reasoningOpen[m.id];
                    return (
                      <div className="mb-2 select-none">
                        <button
                          type="button"
                          onClick={() => setReasoningOpen((s) => ({ ...s, [m.id]: !open }))}
                          className={`flex items-center gap-1 text-[11px] ${mutedCls} hover:opacity-80 transition-colors`}
                        >
                          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <Brain size={11} />
                          <span className="italic">思考过程</span>
                        </button>
                        {open && (
                          <div className={`mt-1 text-[12px] ${mutedCls} border-l-2 border-neutral-300 dark:border-stone-600 pl-2.5 py-0.5 italic whitespace-pre-wrap`}>
                            {m.reasoning}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {/* 多模态：显示用户发的图（与文本同气泡） */}
                  {m.images && m.images.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-1.5">
                      {m.images.map((src, i) => (
                        <img
                          key={i}
                          src={src}
                          alt={`图${i + 1}`}
                          className={`max-w-[200px] max-h-[200px] rounded-xl object-cover ${m.role === 'user' ? '' : 'border border-black/10 dark:border-white/10'}`}
                        />
                      ))}
                    </div>
                  )}
                  {/* 附件（非图片）：文本已在请求中注入，二进制仅陈列文件名 */}
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {m.attachments.map((a, i) => (
                        <span
                          key={i}
                          className={`flex items-center gap-1 max-w-[220px] truncate text-[11px] px-1.5 py-0.5 rounded-md border ${
                            m.role === 'user'
                              ? 'border-black/10 dark:border-white/10'
                              : 'border-neutral-300 dark:border-stone-600'
                          } ${mutedCls}`}
                          title={`${a.name}${a.size != null ? `（${a.size} 字节）` : ''}${a.kind === 'text' ? ' — 文本内容已随消息发送' : ''}`}
                        >
                          {a.kind === 'text' ? <FileText size={12} /> : <FileIcon size={12} />}
                          <span className="truncate">{a.name}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {m.error ? (
                    <span className="text-red-500 dark:text-red-400">{m.content}</span>
                  ) : m.content ? (
                    <div className="md-message" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  ) : (
                    busy && m.role === 'assistant' ? <span className="inline-flex gap-1 text-neutral-400"><span className="animate-pulse">●</span><span className="animate-pulse delay-150">●</span><span className="animate-pulse delay-300">●</span></span> : ''
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* 输入区 */}
      <div className={`border-t ${borderCls} px-6 py-4 flex-shrink-0`}>
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-3">
            <div className={`flex-1 rounded-2xl ${inputWrapCls} px-4 py-2.5 focus-within:border-sky-400 transition-colors`}>
              {/* 附件区：已选图片缩略图 + 文本/二进制文件 chip（可单击移除） */}
              {picked.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {picked.map((p, i) => (
                    <div key={i} className="group relative">
                      {p.kind === 'image' && p.dataUrl ? (
                        <img src={p.dataUrl} alt={`图${i + 1}`} className="w-14 h-14 rounded-lg object-cover border border-black/10 dark:border-white/10" />
                      ) : (
                        <span
                          className={`flex items-center gap-1 max-w-[160px] truncate text-[11px] px-2 py-1 rounded-lg border ${capsuleMode ? 'border-white/10 text-white/70' : 'border-black/10 dark:border-white/10 text-neutral-500 dark:text-stone-400'}`}
                          title={`${p.name}${p.size != null ? `（${p.size} 字节）` : ''}${p.kind === 'text' ? ' — 文本内容将随消息发送' : p.kind === 'image' ? ' — 正在读取图片' : ''}`}
                        >
                          {p.kind === 'text' ? <FileText size={12} /> : <FileIcon size={12} />}
                          <span className="truncate">{p.name}</span>
                        </span>
                      )}
                      <button
                        onClick={() => setPicked((prev) => prev.filter((_, j) => j !== i))}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="移除附件"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                }}
                onPaste={onPaste}
                rows={1}
                placeholder={picked.length ? '可选：输入图片/文件说明；留空直接发送' : "发消息给 AI，粘贴图片/文件或输入文本，Enter 发送"}
                className={`w-full resize-none max-h-40 min-h-[24px] bg-transparent text-sm outline-none ${capsuleMode ? 'text-white placeholder:text-white/40' : 'text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400'}`}
              />
              <div className="flex items-center justify-between mt-1.5">
                <div className="flex items-center gap-2">
                  <ThinkingToggle compact theme={capsuleMode ? 'dark' : 'light'} profileId={profileId} />
                  {onToggleAgent && (
                    <button
                      onClick={() => onToggleAgent(!agent)}
                      title={agent ? '联网模式已开启（可联网 / 调用工具）' : '开启后可联网 / 调用工具'}
                      className={`flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md transition-colors ${
                        agent
                          ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                          : `${capsuleMode ? 'text-white/50 hover:text-white/80' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600'}`
                      }`}
                    >
                      <Sparkles size={13} />
                      <span>联网</span>
                    </button>
                  )}
                  <label className={`flex items-center gap-1 text-[11px] cursor-pointer px-1.5 py-0.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 ${capsuleMode ? 'text-white/50 hover:text-white/80' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600'}`}>
                    <Paperclip size={14} />
                    <span>导入</span>
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => { intoPicked(Array.from(e.target.files || [])); e.target.value = ''; }}
                    />
                  </label>
                </div>
                <span className={`text-[11px] ${capsuleMode ? 'text-white/40' : 'text-neutral-300 dark:text-stone-600'}`}>AI 可能出错，请核实重要信息</span>
              </div>
            </div>
            <button
              onClick={submit}
              disabled={busy || (!input.trim() && picked.length === 0)}
              className={`btn-press w-11 h-11 flex items-center justify-center rounded-2xl ${sendBtnCls} transition-opacity`}
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
