import { useRef, useCallback, useState, useEffect, lazy, Suspense, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bold, Italic, Link2, Code, List, Columns2, Maximize2, FileText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { api } from '@/lib/api';
import { useNotesStore } from '@/stores/notesStore';
import { useAppStore } from '@/stores/appStore';
import type { RichTextEditorHandle } from './RichTextEditor';

// 富文本编辑器（TipTap + prosemirror + 转换逻辑，约 300KB+）改为懒加载：
// 首屏只加载主程序，打开笔记时才按需拉取该 chunk，明显加快启动速度。
const LazyRichTextEditor = lazy(() => import('./RichTextEditor').then(m => ({ default: m.RichTextEditor })));

type EditorMode = 'split' | 'edit-only';

const EDITOR_MODE_KEY = 'editor_view_mode';

export function NotesEditor() {
  const title = useNotesStore(s => s.title);
  const content = useNotesStore(s => s.content);
  const htmlContent = useNotesStore(s => s.htmlContent);
  const onTitleChange = useNotesStore(s => s.setTitle);
  const onContentChange = useNotesStore(s => s.setContent);
  const tags = useNotesStore(s => s.currentNoteTags);
  const allTags = useNotesStore(s => s.allTags);
  const onTagsChange = useNotesStore(s => s.saveTags);
  const wordWrap = useAppStore(s => s.wordWrap);

  const editorRef = useRef<RichTextEditorHandle | null>(null);
  // 用于触发 onUpdate 之外的 content 同步（如外部修改）
  const contentRef = useRef(content);
  contentRef.current = content;

  const [editorMode, setEditorMode] = useState<EditorMode>(() => {
    return (localStorage.getItem(EDITOR_MODE_KEY) as EditorMode) || 'split';
  });

  const handleSetMode = useCallback((mode: EditorMode) => {
    setEditorMode(mode);
    localStorage.setItem(EDITOR_MODE_KEY, mode);
  }, []);

  // ---- 工具栏：TipTap 编辑器命令 ----
  const getEditor = () => editorRef.current?.editor;

  const handleBold = useCallback(() => getEditor()?.chain().focus().toggleBold().run(), []);
  const handleItalic = useCallback(() => getEditor()?.chain().focus().toggleItalic().run(), []);
  const handleCode = useCallback(() => getEditor()?.chain().focus().toggleCode().run(), []);

  const handleLink = useCallback(() => {
    const editor = getEditor();
    if (!editor) return;
    const existing = editor.getAttributes('link').href;
    const url = window.prompt(existing ? '编辑链接 URL：' : '输入链接 URL：', existing || 'https://');
    if (url === null) return;
    if (url === '' || url === existing) {
      editor.chain().focus().unsetLink().run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
  }, []);

  const handleList = useCallback(() => getEditor()?.chain().focus().toggleBulletList().run(), []);

  // 键盘快捷键（Ctrl+B/I/K）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (!isCtrl) return;
      const target = e.target as HTMLElement;
      if (target.closest('.ProseMirror') || target.tagName === 'INPUT') {
        if (e.key === 'b' || e.key === 'i' || e.key === 'k') {
          e.preventDefault();
          if (e.key === 'b') handleBold();
          else if (e.key === 'i') handleItalic();
          else if (e.key === 'k') handleLink();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleBold, handleItalic, handleLink]);

  // 整块删除图片：TipTap 中图片是原子节点，Backspace / Delete 会自然删除整块节点。
  // 此处保留键盘钩子仅用于特殊场景（如需要连带删除图片前后空行）
  const handleEditorKeyDown = useCallback((_e: ReactKeyboardEvent) => {
    // TipTap 的 Image 节点是原子的，Backspace/Delete 自然删除整张图。
    // 保留此钩子为空，方便后续扩展。
  }, []);

  // 标签编辑状态
  const [tagInput, setTagInput] = useState('');
  const handleAddTag = useCallback(() => {
    const t = tagInput.trim();
    if (t && !tags.includes(t) && onTagsChange) {
      onTagsChange([...tags, t]);
    }
    setTagInput('');
  }, [tagInput, tags, onTagsChange]);

  const handleRemoveTag = useCallback((tag: string) => {
    if (onTagsChange) {
      onTagsChange(tags.filter(t => t !== tag));
    }
  }, [tags, onTagsChange]);

  const unusedTags = allTags.filter(t => !tags.includes(t));

  // 万能拖拽功能（在 RichTextEditor 容器上）
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    if ((window as unknown as Record<string, unknown>).__andengDragging) return;
    if (Array.from(e.dataTransfer.types).includes('application/x-andeng-internal')) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const currentContent = contentRef.current;
    let newContent = currentContent;

    for (const file of files) {
      const fileName = file.name;
      const fileExt = fileName.split('.').pop()?.toLowerCase() || '';

      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(fileExt)) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const ref = await api.addImageBytesToDropzone(dataUrl, fileName);
          newContent += `\n![${fileName}](${ref})\n`;
        } catch {
          const tsPath = `./transfer_station/${fileName}`;
          newContent += `\n[🖼 ${fileName}](${tsPath})\n`;
        }
      } else if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(fileExt)) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const md = await invoke<string>('convert_bytes_to_markdown', { base64: dataUrl, extension: fileExt, originalName: fileName });
          newContent += `\n---\n# ${fileName}\n\n${md}\n---\n`;
        } catch {
          const tsPath = `./transfer_station/${fileName}`;
          newContent += `\n[📄 ${fileName}](${tsPath})\n`;
        }
      } else if ([
        'txt', 'md', 'markdown', 'bat', 'cmd', 'sh', 'bash', 'ps1',
        'py', 'js', 'ts', 'jsx', 'tsx', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
        'css', 'scss', 'less', 'html', 'htm', 'svg',
        'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
        'csv', 'log', 'sql', 'r', 'rb', 'php', 'swift', 'kt', 'lua', 'vbs',
      ].includes(fileExt)) {
        try {
          const text = await file.text();
          const lang = fileExt === 'markdown' ? 'md' : fileExt;
          newContent += `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
        } catch {
          const tsPath = `./transfer_station/${fileName}`;
          newContent += `\n[📝 ${fileName}](${tsPath})\n`;
        }
      } else {
        const tsPath = `./transfer_station/${fileName}`;
        newContent += `\n[📎 ${fileName}](${tsPath})\n`;
      }
    }

    onContentChange(newContent);
  }, [onContentChange]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleImportDocument = useCallback(async () => {
    try {
      const files = await invoke<string[]>('pick_file', {
        filters: [{ name: '文档', extensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'html', 'htm', 'csv', 'json', 'xml', 'zip', 'epub'] }]
      });
      if (!files || files.length === 0) return;

      let inserted = '';
      const failed: string[] = [];
      for (const filePath of files) {
        try {
          const markdown = await invoke<string>('convert_to_markdown', { filePath });
          const fileName = filePath.split(/[\\/]/).pop() || filePath;
          inserted += `\n---\n# ${fileName}\n\n${markdown}\n---\n`;
        } catch (err) {
          console.error('[NotesEditor] 转换失败:', filePath, err);
          failed.push(filePath.split(/[\\/]/).pop() || filePath);
        }
      }
      if (inserted) onContentChange(content + inserted);
      if (failed.length > 0) {
        alert(`以下文件转换失败（文件格式可能不受支持或已损坏）：\n${failed.join('\n')}`);
      }
    } catch (err) {
      console.error('[NotesEditor] 导入文档失败:', err);
    }
  }, [content, onContentChange]);

  const toolbarBtnClass = 'btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors';

  return (
    <div className="flex flex-col h-full w-full overflow-hidden gap-4 min-h-0">
      {/* 标题行 */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <input
          type="text"
          className="flex-1 text-3xl font-bold bg-transparent border-none outline-none text-neutral-800 placeholder:text-neutral-400/50 dark:text-stone-100 dark:placeholder:text-stone-600/50"
          placeholder="笔记标题"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
        />
        <div className="flex items-center gap-0.5 bg-black/5 dark:bg-white/5 rounded-lg p-0.5 flex-shrink-0">
          <button
            onClick={() => handleSetMode('split')}
            className={`btn-press p-1.5 rounded-md transition-all duration-200 ${
              editorMode === 'split'
                ? 'bg-[var(--element-bg)] text-white shadow-sm'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'
            }`}
            title="双栏"
          >
            <Columns2 size={16} />
          </button>
          <button
            onClick={() => handleSetMode('edit-only')}
            className={`btn-press p-1.5 rounded-md transition-all duration-200 ${
              editorMode === 'edit-only'
                ? 'bg-[var(--element-bg)] text-white shadow-sm'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'
            }`}
            title="仅编辑"
          >
            <Maximize2 size={16} />
          </button>
        </div>
      </div>

      {/* 标签行 */}
      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap min-h-0">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 border border-blue-200/50 dark:border-blue-700/30">
            {tag}
            <button onClick={() => handleRemoveTag(tag)} className="hover:text-blue-700 dark:hover:text-blue-200 ml-0.5">&times;</button>
          </span>
        ))}
        <input
          type="text"
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTag(); } }}
          placeholder={tags.length === 0 ? '添加标签...' : ''}
          className="text-xs bg-transparent border-none outline-none text-neutral-500 dark:text-stone-400 placeholder:text-neutral-400/50 w-24"
          list="tag-suggestions"
        />
        <datalist id="tag-suggestions">
          {unusedTags.map(t => <option key={t} value={t} />)}
        </datalist>
      </div>

      {/* 格式化工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-white/50 dark:bg-stone-800/50 backdrop-blur-sm rounded-xl border border-white/50 dark:border-stone-600/30 flex-shrink-0 w-fit">
        <button onClick={handleBold} className={toolbarBtnClass} title="加粗 (Ctrl+B)">
          <Bold size={16} />
        </button>
        <button onClick={handleItalic} className={toolbarBtnClass} title="斜体 (Ctrl+I)">
          <Italic size={16} />
        </button>
        <button onClick={handleLink} className={toolbarBtnClass} title="链接 (Ctrl+K)">
          <Link2 size={16} />
        </button>
        <button onClick={handleCode} className={toolbarBtnClass} title="内联代码">
          <Code size={16} />
        </button>
        <button onClick={handleList} className={toolbarBtnClass} title="无序列表">
          <List size={16} />
        </button>
        <div className="w-px h-4 bg-neutral-200/50 dark:bg-stone-600/50 mx-0.5" />
        <button onClick={handleImportDocument} className={toolbarBtnClass} title="导入文档 (PDF/Word/PPT/Excel...)">
          <FileText size={16} />
        </button>
      </div>

      {/* 编辑卡 */}
      <div
        className="flex-1 flex w-full min-h-0 bg-white/90 backdrop-blur-sm rounded-2xl shadow-sm border border-white/50 overflow-hidden dark:bg-stone-800/80 dark:border-stone-600/40"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {/* 左侧：富文本编辑区 */}
        <div className={`flex-1 flex flex-col min-h-0 ${editorMode === 'split' ? 'border-r border-neutral-200/30 dark:border-stone-700/30' : ''}`}>
          <div className="px-4 py-3 border-b border-neutral-200/30 flex-shrink-0 dark:border-stone-700/30">
            <span className="text-xs font-medium text-neutral-400 dark:text-stone-500">编辑</span>
          </div>
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-sm text-neutral-400 dark:text-stone-500">编辑器加载中…</div>}>
            <LazyRichTextEditor
              editorRef={editorRef}
              content={content}
              onContentChange={onContentChange}
              placeholder="在此输入内容..."
              wordWrap={wordWrap}
              onKeyDown={handleEditorKeyDown}
            />
          </Suspense>
        </div>

        {/* 右侧：实时预览区（仅双栏模式） */}
        {editorMode === 'split' && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-neutral-200/30 flex-shrink-0 dark:border-stone-700/30">
              <span className="text-xs font-medium text-neutral-400 dark:text-stone-500">预览</span>
            </div>
            <div
              className="flex-1 w-full h-full p-5 overflow-y-auto prose prose-sm max-w-none text-neutral-700 leading-7 dark:text-stone-300 [&_p]:my-0 [&_p]:leading-7"
              dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default NotesEditor;
