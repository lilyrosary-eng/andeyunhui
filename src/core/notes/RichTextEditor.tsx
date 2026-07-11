import { forwardRef, useEffect, useImperativeHandle, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import ImageExtension from '@tiptap/extension-image';
import LinkExtension from '@tiptap/extension-link';
import PlaceholderExtension from '@tiptap/extension-placeholder';
import { marked } from 'marked';

type Editor = NonNullable<ReturnType<typeof useEditor>>;

/**
 * Markdown → TipTap 兼容 HTML（利用已有的 marked 库）
 * TipTap 的 setContent 接受 HTML，但只识别它 schema 内的元素。
 * marked 输出的是标准 HTML，TipTap 可解析其中的 h1-h6、p、strong、em、code、ul/ol/li、blockquote、img 等。
 */
function mdToEditorHtml(md: string): string {
  if (!md.trim()) return '';
  // marked 解析 markdown 为 HTML
  const raw = marked.parse(md, { async: false }) as string;
  // 移除 wrapping <p> 的自动换行（保留结构）
  return raw;
}

/**
 * TipTap HTML → Markdown（反向转换，用于保存）
 * TipTap 生成的是干净、结构化的 HTML，可以安全地做标记替换。
 */
function editorHtmlToMd(html: string): string {
  let md = html;

  // 链接：<a href="url">text</a> → [text](url)
  md = md.replace(/<a[^>]*\shref="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // 图片：<img src="url"> → ![](url)
  md = md.replace(/<img[^>]*\ssrc="([^"]*)"[^>]*\/?>/gi, (_m, src) => `\n![](${src})\n`);

  // 粗体：<strong> / <b>
  md = md.replace(/<\/?(?:strong|b)>/gi, '**');

  // 斜体：<em> / <i>
  md = md.replace(/<\/?(?:em|i)>/gi, '*');

  // 内联代码：<code>
  md = md.replace(/<\/?code>/gi, '`');

  // 删除线：<s> / <del> / <strike>
  md = md.replace(/<\/?(?:s|del|strike)>/gi, '~~');

  // 段落：<p> 去标签，保留换行
  md = md.replace(/<\/p>\s*<p>/gi, '\n\n');
  md = md.replace(/<\/?p>/gi, '');

  // 换行：<br>
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 标题：h1-h6
  md = md.replace(/<h(\d)>/gi, (_m, level) => '\n' + '#'.repeat(Number(level)) + ' ');
  md = md.replace(/<\/h\d>/gi, '\n');

  // 无序列表
  md = md.replace(/<li>\s*/gi, '- ');
  md = md.replace(/<\/li>/gi, '\n');
  md = md.replace(/<\/?ul>/gi, '');

  // 有序列表
  let olIdx = 0;
  md = md.replace(/<ol>/gi, () => { olIdx = 0; return ''; });
  md = md.replace(/<li>/gi, () => { olIdx += 1; return `${olIdx}. `; });
  md = md.replace(/<\/ol>/gi, '');

  // 引用
  md = md.replace(/<blockquote>/gi, '\n> ');
  md = md.replace(/<\/blockquote>/gi, '\n');

  // 水平线
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

  // 清理多余的 HTML 标签
  md = md.replace(/<[^>]+>/g, '');

  // 清理多余空行
  md = md.replace(/\n{3,}/g, '\n\n');

  // HTML 实体解码
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");

  return md.trim();
}

export interface RichTextEditorHandle {
  editor: Editor | null;
}

interface RichTextEditorProps {
  content: string;
  onContentChange: (md: string) => void;
  placeholder?: string;
  wordWrap?: boolean;
  /** 键盘事件透传 */
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor({
  content,
  onContentChange,
  placeholder = '在此输入内容...',
  wordWrap = true,
  onKeyDown,
}, ref) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      ImageExtension.configure({
        inline: false,
        allowBase64: false,
      }),
      LinkExtension.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-blue-500 underline' },
      }),
      PlaceholderExtension.configure({ placeholder }),
    ],
    editorProps: {
      attributes: {
        class: `prose prose-sm max-w-none outline-none min-h-full p-5 text-sm leading-7 text-neutral-700 dark:text-stone-300 ${wordWrap ? '' : 'whitespace-pre'}`,
      },
      handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
        // 透传给父组件的 onKeyDown（用于 Backspace 图片整删等逻辑）
        if (onKeyDown) {
          onKeyDown(event as unknown as React.KeyboardEvent);
          if (event.defaultPrevented) return true;
        }
        return false;
      },
    },
    content: mdToEditorHtml(content),
    onUpdate: ({ editor }: { editor: Editor }) => {
      const html = editor.getHTML();
      const md = editorHtmlToMd(html);
      onContentChange(md);
    },
  });

  // 暴露 editor 实例给父组件的工具栏（Bold/Italic/Code 等）
  useImperativeHandle(ref, () => ({ editor }), [editor]);

  // 外部内容变化时同步到编辑器（如切换笔记）
  useEffect(() => {
    if (!editor) return;
    const currentMd = editorHtmlToMd(editor.getHTML());
    if (currentMd !== content) {
      editor.commands.setContent(mdToEditorHtml(content));
    }
  }, [content, editor]);

  return (
    <div className="flex-1 w-full h-full overflow-auto">
      <EditorContent editor={editor} className="h-full" />
    </div>
  );
});

export default RichTextEditor;
