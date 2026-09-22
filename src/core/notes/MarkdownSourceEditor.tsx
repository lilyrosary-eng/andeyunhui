import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
} from 'react';
import {
  prefixMarkdownLines,
  wrapMarkdownSelection,
  type MarkdownEditState,
} from './markdown';

/** 供工具栏 / 快捷键调用的编辑指令句柄（全部在原始 Markdown 文本上操作） */
export interface MarkdownSourceEditorHandle {
  /** 用标记包裹选区（加粗 `**`、斜体 `*`、内联代码 `` ` ``、链接 `[]()`） */
  wrapSelection: (before: string, after: string, placeholder?: string) => void;
  /** 给选中行加行首标记（标题 `## `、无序列表 `- `、引用 `> `） */
  prefixLines: (prefix: string) => void;
  /** 用新文本整体替换选区（AI 润色结果回填） */
  replaceSelection: (text: string) => void;
  /** 当前选区（start / end / 选中文本） */
  getSelection: () => { start: number; end: number; text: string };
}

interface MarkdownSourceEditorProps {
  content: string;
  onContentChange: (md: string) => void;
  placeholder?: string;
  wordWrap?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * 笔记编辑区：原始 Markdown 文本编辑（受控 textarea）。
 *
 * 为什么不再用 TipTap 富文本：编辑区必须显示字面 `## 标题`，富文本渲染会吃掉标记、
 * 也让「编辑 / 预览」职责重叠。这里只做纯文本编辑，格式化按钮改由指令句柄插入
 * 字面 Markdown 标记，因此不需要任何新依赖。
 */
export const MarkdownSourceEditor = forwardRef<MarkdownSourceEditorHandle, MarkdownSourceEditorProps>(
  function MarkdownSourceEditor(
    { content, onContentChange, placeholder, wordWrap = true, onKeyDown },
    ref,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // 受控 textarea 的坑：React 写入新 value 时浏览器会把光标推到末尾。
    // 因此指令先记下目标选区，等 content 更新（重渲染）后再统一恢复光标。
    const pendingSelection = useRef<{ start: number; end: number } | null>(null);

    useEffect(() => {
      const sel = pendingSelection.current;
      const el = textareaRef.current;
      if (!sel || !el) return;
      pendingSelection.current = null;
      el.focus();
      el.setSelectionRange(sel.start, sel.end);
    }, [content]);

    /** 读取当前文本与选区；编辑器尚未挂载时退化为「文末」 */
    const readState = useCallback((): MarkdownEditState => {
      const el = textareaRef.current;
      if (!el) return { text: content, selectionStart: content.length, selectionEnd: content.length };
      return { text: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd };
    }, [content]);

    const apply = useCallback(
      (next: MarkdownEditState) => {
        const el = textareaRef.current;
        if (!el) return;
        pendingSelection.current = { start: next.selectionStart, end: next.selectionEnd };
        if (next.text !== el.value) onContentChange(next.text);
      },
      [onContentChange],
    );

    useImperativeHandle(ref, () => ({
      wrapSelection: (before, after, placeholderText) => {
        apply(wrapMarkdownSelection(readState(), before, after, placeholderText));
      },
      prefixLines: (prefix) => {
        apply(prefixMarkdownLines(readState(), prefix));
      },
      replaceSelection: (text) => {
        apply(wrapMarkdownSelection(readState(), text, ''));
      },
      getSelection: () => {
        const { text, selectionStart, selectionEnd } = readState();
        return { start: selectionStart, end: selectionEnd, text: text.slice(selectionStart, selectionEnd) };
      },
    }), [apply, readState]);

    const fontStyle = wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre';

    return (
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        wrap={wordWrap ? 'soft' : 'off'}
        className={`w-full h-full flex-1 min-h-0 resize-none overflow-auto bg-transparent outline-none px-5 py-4 text-sm leading-7 font-mono text-neutral-700 dark:text-stone-300 placeholder:text-neutral-400/60 dark:placeholder:text-stone-600/60 selection:bg-blue-200/60 dark:selection:bg-blue-500/30 ${fontStyle}`}
      />
    );
  },
);

export default MarkdownSourceEditor;