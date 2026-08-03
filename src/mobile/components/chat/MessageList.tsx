// AI 对话消息列表（§4.1）。
//
// 渲染扁平时间线（消息 / 来源分隔 / 降级卡片），用 @tanstack/react-virtual 做动态高度
// 虚拟滚动，支撑长对话历史（项目约束：消息列表需虚拟滚动避免卡顿）。
//
// 自动跟随底部：流式输出时若用户已在底部则自动滚动；用户主动上滑查看历史时不打断
// （避免「读历史被拉回底部」的反体验）。resize 事件用 rAF 节流（项目约束：resize 防抖）。
//
// 消息样式（§4.1）：
//   用户消息：右对齐，气泡 --element-bg
//   AI 消息：左对齐，无气泡，纯文字 17px（--m-text-body-lg）
//   AI 消息底栏：来源溯源 + 复制 + 重来（§6.3.2 支点 2）

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy, RotateCcw, Check, ChevronDown, ChevronRight } from 'lucide-react';

import type { ChatMsg, TimelineItem } from '../../types/chat';
import { SourceDivider } from './SourceDivider';
import { DegradeCard } from './DegradeCard';

interface MessageListProps {
  timeline: TimelineItem[];
  busy: boolean;
  /** 是否存在可用云端 profile（降级卡片「改用云端」启用态） */
  cloudAvailable: boolean;
  onRetry: () => void;
  onSwitchCloud: () => void;
}

const KIND_ICON: Record<string, string> = {
  local: '🖥',
  cloud: '☁',
  device: '📱',
  down: '⚠',
  unconfigured: '○',
};

export function MessageList({ timeline, busy, cloudAvailable, onRetry, onSwitchCloud }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const count = timeline.length;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 6,
    // 动态高度：流式追加文本会改变行高，开启测量后虚拟器自动重算
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // 用户在底部时才自动跟随；上滑查看历史时不强制拉回
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
  }, []);

  // resize 用 rAF 节流（项目约束：resize 事件需防抖，避免高频重排卡顿）
  useEffect(() => {
    let ticking = false;
    const onResize = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        virtualizer.measure();
        ticking = false;
      });
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [virtualizer]);

  // 新消息或流式追加时，若用户在底部则跟随滚动
  const lastItem = timeline[count - 1];
  const lastContent = lastItem?.type === 'message' ? lastItem.msg.content : '';
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [count, lastContent, busy]);

  const handleCopy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      // 剪贴板被沙箱限制时静默失败（不阻断对话）
    }
  }, []);

  const items = virtualizer.getVirtualItems();

  // 空态：timeline 为空时展示引导（不进入虚拟器，避免 0 项的 measure 抖动）
  if (count === 0) {
    return (
      <div
        ref={scrollRef}
        className="flex-1 flex items-center justify-center overflow-y-auto"
        style={{ contain: 'strict' }}
      >
        <p className="text-[var(--muted-foreground)] px-8 text-center" style={{ fontSize: 'var(--m-text-body)' }}>
          选择算力来源后，在下方输入框开始对话。
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto overscroll-contain"
      // contain:strict 让滚动容器独立合成，减少外部重排影响
      style={{ contain: 'strict', WebkitOverflowScrolling: 'touch' }}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {items.map((vi) => {
          const item = timeline[vi.index];
          return (
            <div
              key={item.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {item.type === 'divider' && <SourceDivider source={item.source} />}
              {item.type === 'degrade' && (
                <DegradeCard
                  reason={item.reason}
                  cloudAvailable={cloudAvailable}
                  onRetry={onRetry}
                  onSwitchCloud={onSwitchCloud}
                />
              )}
              {item.type === 'message' && (
                <MessageRow
                  msg={item.msg}
                  busy={busy}
                  copied={copiedId === item.msg.id}
                  onCopy={() => handleCopy(item.msg.id, item.msg.content)}
                  onRetry={onRetry}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 单条消息渲染（用户气泡 / AI 纯文本 + 思维链 + 操作栏） */
function MessageRow({
  msg,
  busy,
  copied,
  onCopy,
  onRetry,
}: {
  msg: ChatMsg;
  busy: boolean;
  copied: boolean;
  onCopy: () => void;
  onRetry: () => void;
}) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const isUser = msg.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div
          className="rounded-2xl rounded-br-md"
          style={{
            backgroundColor: 'var(--element-bg)',
            color: 'var(--element-fg)',
            padding: '9px 13px',
            fontSize: 'var(--m-text-body-lg)',
            lineHeight: 1.5,
            maxWidth: '82%',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        >
          {msg.content}
        </div>
      </div>
    );
  }

  // assistant
  const hasReasoning = !!msg.reasoning && msg.reasoning.trim().length > 0;
  const streaming = busy && msg.content === '' && !msg.error;
  const sourceIcon = msg.source ? KIND_ICON[msg.source.kind] : null;

  return (
    <div className="px-3 py-1.5">
      <div style={{ maxWidth: '92%' }}>
        {/* 思维链（可折叠遮罩） */}
        {hasReasoning && (
          <button
            type="button"
            onClick={() => setReasoningOpen((v) => !v)}
            className="flex items-center gap-1 mb-1.5 text-[var(--muted-foreground)] active:opacity-70 transition-opacity"
            style={{ fontSize: 'var(--m-text-caption)' }}
          >
            {reasoningOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            思考过程
          </button>
        )}
        {hasReasoning && reasoningOpen && (
          <div
            className="mb-2 rounded-lg overflow-hidden"
            style={{
              backgroundColor: 'var(--muted)',
              padding: '8px 10px',
              fontSize: 'var(--m-text-caption)',
              lineHeight: 1.5,
              color: 'var(--muted-foreground)',
              whiteSpace: 'pre-wrap',
              maxHeight: '200px',
              overflowY: 'auto',
            }}
          >
            {msg.reasoning}
          </div>
        )}

        {/* 正文 */}
        {streaming ? (
          <div className="flex items-center gap-1.5 py-1" style={{ color: 'var(--muted-foreground)' }}>
            <span
              className="inline-block rounded-full"
              style={{
                width: '6px', height: '6px',
                backgroundColor: 'var(--muted-foreground)',
                animation: 'ai-blink 1.2s ease-in-out infinite',
              }}
            />
            <span style={{ fontSize: 'var(--m-text-caption)' }}>思考中…</span>
          </div>
        ) : (
          <div
            style={{
              fontSize: 'var(--m-text-body-lg)',
              lineHeight: 1.55,
              color: msg.error ? 'var(--destructive)' : 'var(--foreground)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {msg.content}
            {busy && !msg.error && (
              <span
                className="inline-block ml-0.5"
                style={{
                  width: '7px', height: 'var(--m-text-body-lg)',
                  backgroundColor: 'var(--foreground)',
                  opacity: 0.5,
                  animation: 'ai-blink 1s step-end infinite',
                  verticalAlign: 'text-bottom',
                }}
              />
            )}
          </div>
        )}

        {/* 操作栏：来源溯源 + 复制 + 重来（§6.3.2 支点 2） */}
        {!streaming && !msg.error && msg.content && (
          <div className="flex items-center gap-3 mt-1.5" style={{ fontSize: 'var(--m-text-overline)' }}>
            {msg.source && (
              <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
                <span>{sourceIcon}</span>
                {msg.source.label}
              </span>
            )}
            <button
              type="button"
              onClick={onCopy}
              className="flex items-center gap-1 text-[var(--muted-foreground)] active:opacity-60 transition-opacity"
              aria-label="复制"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="flex items-center gap-1 text-[var(--muted-foreground)] active:opacity-60 transition-opacity disabled:opacity-40"
              aria-label="重来"
            >
              <RotateCcw size={12} />
              重来
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
