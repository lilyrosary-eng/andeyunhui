// AI 对话输入区（§4.1 / §6.3.4）。
//
// 多行自增高 textarea（最多 5 行，超出滚动）；上方堆叠上下文芯片（§6.3.4 预留位）；
// 左 📎 附件、右 ⬆ 发送。移动端 Enter = 换行，发送只走按钮（符合移动 IM 惯例）。
//
// 附件：§6.3.4 明确首发仅支持「本地选文件」一种注入，避免为未验证契约过度设计。
// 选中文件后加入上下文芯片；真实多模态发送（图片理解等）属 L6，本组件仅做 UI 占位。

import { useCallback, useRef, useState } from 'react';
import { Paperclip, ArrowUp, Square } from 'lucide-react';
import { ContextChips, type ContextChipItem } from './ContextChips';

const MAX_LINES = 5;
const LINE_HEIGHT = 22; // px，约对应 --m-text-body-lg * 1.5

interface ChatInputProps {
  busy: boolean;
  onSend: (text: string) => void;
  /** 流式中点击「停止」——当前后端无 abort 命令，这里禁用按钮以如实表达 */
  onStop?: () => void;
}

export function ChatInput({ busy, onSend }: ChatInputProps) {
  const [text, setText] = useState('');
  const [chips, setChips] = useState<ContextChipItem[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 自增高：依据 scrollHeight 调整，封顶 5 行
  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxH = LINE_HEIGHT * MAX_LINES;
    ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
  }, []);

  const handleSend = useCallback(() => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText('');
    // 清空后重置高度
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto';
    });
  }, [text, busy, onSend]);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newChips: ContextChipItem[] = Array.from(files).map((f) => ({
      id: 'chip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: f.name,
      source: 'local-file' as const,
    }));
    setChips((prev) => [...prev, ...newChips]);
    // 重置 value 允许重复选同一文件
    e.target.value = '';
  }, []);

  const removeChip = useCallback((id: string) => {
    setChips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const canSend = text.trim().length > 0 && !busy;

  return (
    <div
      className="shrink-0 bg-[var(--background)]"
      style={{
        borderTop: '1px solid var(--border)',
        paddingBottom: 'var(--safe-bottom)',
      }}
    >
      <ContextChips items={chips} onRemove={removeChip} />

      <div className="flex items-end gap-2 px-3 py-2.5">
        {/* 附件按钮 */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="shrink-0 flex items-center justify-center rounded-full active:scale-90 transition-transform"
          style={{
            width: 'var(--touch-min)',
            height: 'var(--touch-min)',
            color: 'var(--muted-foreground)',
          }}
          aria-label="添加附件"
        >
          <Paperclip size={20} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFile}
          // accept 留空允许任意文件；图片优先（未来多模态）
          accept="image/*"
        />

        {/* 多行输入框 */}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => { setText(e.target.value); autoGrow(); }}
          onInput={autoGrow}
          rows={1}
          placeholder="说点什么…"
          className="flex-1 resize-none outline-none bg-transparent"
          style={{
            color: 'var(--foreground)',
            fontSize: 'var(--m-text-body-lg)',
            lineHeight: `${LINE_HEIGHT}px`,
            maxHeight: `${LINE_HEIGHT * MAX_LINES}px`,
            padding: '10px 0',
            // 修复 WebView 内 textarea 自带内边距与字体继承
            fontFamily: 'inherit',
          }}
          aria-label="对话输入"
        />

        {/* 发送 / 流式占位 */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="shrink-0 flex items-center justify-center rounded-full transition-transform active:scale-90 disabled:active:scale-100 disabled:opacity-40"
          style={{
            width: 'var(--touch-min)',
            height: 'var(--touch-min)',
            backgroundColor: canSend ? 'var(--primary)' : 'var(--muted)',
            color: 'var(--primary-foreground)',
          }}
          aria-label={busy ? '生成中' : '发送'}
        >
          {busy ? <Square size={16} fill="currentColor" /> : <ArrowUp size={20} />}
        </button>
      </div>
    </div>
  );
}
