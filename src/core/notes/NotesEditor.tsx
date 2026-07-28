import { useRef, useCallback, useState, useEffect, lazy, Suspense, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bold, Italic, Link2, Code, List, Columns2, Maximize2, FileText, Sparkles, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api } from '@/lib/api';
import { useNotesStore } from '@/stores/notesStore';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/lib/i18n';
import type { RichTextEditorHandle } from './RichTextEditor';

// 富文本编辑器（TipTap + prosemirror + 转换逻辑，约 300KB+）改为懒加载：
// 首屏只加载主程序，打开笔记时才按需拉取该 chunk，明显加快启动速度。
const LazyRichTextEditor = lazy(() => import('./RichTextEditor').then(m => ({ default: m.RichTextEditor })));

type EditorMode = 'split' | 'edit-only';

const EDITOR_MODE_KEY = 'editor_view_mode';

export function NotesEditor() {
  const { t: tr } = useI18n();
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
    const url = window.prompt(existing ? tr('notesEditor.editLinkUrl') : tr('notesEditor.enterLinkUrl'), existing || 'https://');
    if (url === null) return;
    if (url === '' || url === existing) {
      editor.chain().focus().unsetLink().run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
  }, [tr]);

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
        filters: [{ name: tr('notesEditor.docFilter'), extensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'html', 'htm', 'csv', 'json', 'xml', 'zip', 'epub'] }]
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
        alert(`${tr('notesEditor.convertFailed')}\n${failed.join('\n')}`);
      }
    } catch (err) {
      console.error('[NotesEditor] 导入文档失败:', err);
    }
  }, [content, onContentChange, tr]);

  // ---- AI 润色：选中文字后调用全局 AI 进行润色，风格/篇幅取自「笔记模块专属设置」 ----
  const [polishing, setPolishing] = useState(false);

  const handleAiPolish = useCallback(async () => {
    const editor = getEditor();
    if (!editor || polishing) return;
    const { from, to, empty } = editor.state.selection;
    const selectedText = empty ? '' : editor.state.doc.textBetween(from, to, '\n');
    if (!selectedText.trim()) {
      alert(tr('notesEditor.polishSelectFirst'));
      return;
    }

    // 读取笔记模块专属设置中的润色风格 / 篇幅（与 NoteSettingsPanel 的 localStorage key 对齐）
    const style = localStorage.getItem('ai_polish_style') || 'keep';
    const length = localStorage.getItem('ai_polish_length') || 'keep';
    const styleMap: Record<string, string> = {
      keep: '保持原有风格',
      concise: '更简洁凝练',
      formal: '更正式、严谨',
      vivid: '更生动、形象',
      casual: '更口语化、亲切自然',
      professional: '更专业、书面化',
    };
    const lengthMap: Record<string, string> = {
      shorter: '在保留核心信息的前提下适当精简篇幅',
      keep: '篇幅与原文大致相当',
      longer: '适当扩写、补充细节，使内容更充实',
    };
    const styleReq = styleMap[style] || styleMap.keep;
    const lengthReq = lengthMap[length] || lengthMap.keep;

    const prompt = [
      '你是一名中文写作润色助手。请对下面这段文字进行润色，使其表达更流畅、通顺、准确。',
      `润色风格要求：${styleReq}。`,
      `篇幅要求：${lengthReq}。`,
      '注意：只输出润色后的正文本身，不要添加任何解释、前后缀、引号或 Markdown 代码围栏；保持与原文一致的语言。',
      '',
      '原文：',
      selectedText,
    ].join('\n');

    setPolishing(true);
    const reqId = 'polish_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let acc = '';
    let done = false;
    let errMsg: string | null = null;
    const unlistenDelta = await listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
      if (e.payload.requestId === reqId) acc += e.payload.delta;
    });
    const unlistenDone = await listen<{ requestId: string }>('ai-done', (e) => {
      if (e.payload.requestId === reqId) done = true;
    });
    const unlistenError = await listen<{ requestId: string; error: string }>('ai-error', (e) => {
      if (e.payload.requestId === reqId) { errMsg = e.payload.error; done = true; }
    });
    try {
      await invoke('ai_chat', {
        requestId: reqId,
        messages: [{ role: 'user', content: prompt }],
      });
      // 等待流式事件收尾（ai_chat 通常在 ai-done 后返回，此处兜底等待增量刷新完）
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => { if (done) { clearInterval(timer); resolve(); } }, 60);
        setTimeout(() => { clearInterval(timer); resolve(); }, 60000);
      });
    } catch (e) {
      errMsg = errMsg || String(e);
    } finally {
      unlistenDelta(); unlistenDone(); unlistenError();
      setPolishing(false);
    }

    if (errMsg) {
      alert(tr('notesEditor.polishFailed') + errMsg);
      return;
    }
    let result = acc.trim();
    if (!result) {
      alert(tr('notesEditor.polishEmpty'));
      return;
    }
    // 剥离可能残留的 markdown 代码围栏
    result = result.replace(/^\s*```[^\n]*\n/, '').replace(/\n```\s*$/, '').trim();
    // 用润色结果替换原选区
    editor.chain().focus().insertContentAt({ from, to }, result).run();
  }, [polishing, tr]);

  const toolbarBtnClass = 'btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors';

  return (
    <div className="flex flex-col h-full w-full overflow-hidden gap-4 min-h-0">
      {/* 标题行 */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <input
          type="text"
          className="flex-1 text-3xl font-bold bg-transparent border-none outline-none text-neutral-800 placeholder:text-neutral-400/50 dark:text-stone-100 dark:placeholder:text-stone-600/50"
          placeholder={tr('notesEditor.titlePlaceholder')}
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
            title={tr('notesEditor.modeSplit')}
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
            title={tr('notesEditor.modeEditOnly')}
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
          placeholder={tags.length === 0 ? tr('notesEditor.addTagPlaceholder') : ''}
          className="text-xs bg-transparent border-none outline-none text-neutral-500 dark:text-stone-400 placeholder:text-neutral-400/50 w-24"
          list="tag-suggestions"
        />
        <datalist id="tag-suggestions">
          {unusedTags.map(t => <option key={t} value={t} />)}
        </datalist>
      </div>

      {/* 格式化工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-white/50 dark:bg-stone-800/50 backdrop-blur-sm rounded-xl border border-white/50 dark:border-stone-600/30 flex-shrink-0 w-fit">
        <button onClick={handleBold} className={toolbarBtnClass} title={tr('notesEditor.bold')}>
          <Bold size={16} />
        </button>
        <button onClick={handleItalic} className={toolbarBtnClass} title={tr('notesEditor.italic')}>
          <Italic size={16} />
        </button>
        <button onClick={handleLink} className={toolbarBtnClass} title={tr('notesEditor.link')}>
          <Link2 size={16} />
        </button>
        <button onClick={handleCode} className={toolbarBtnClass} title={tr('notesEditor.inlineCode')}>
          <Code size={16} />
        </button>
        <button onClick={handleList} className={toolbarBtnClass} title={tr('notesEditor.bulletList')}>
          <List size={16} />
        </button>
        <div className="w-px h-4 bg-neutral-200/50 dark:bg-stone-600/50 mx-0.5" />
        <button onClick={handleAiPolish} disabled={polishing} className={toolbarBtnClass} title={tr('notesEditor.aiPolish')}>
          {polishing ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        </button>
        <button onClick={handleImportDocument} className={toolbarBtnClass} title={tr('notesEditor.importDoc')}>
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
            <span className="text-xs font-medium text-neutral-400 dark:text-stone-500">{tr('notesEditor.editLabel')}</span>
          </div>
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-sm text-neutral-400 dark:text-stone-500">{tr('notesEditor.editorLoading')}</div>}>
            <LazyRichTextEditor
              editorRef={editorRef}
              content={content}
              onContentChange={onContentChange}
              placeholder={tr('notesEditor.contentPlaceholder')}
              wordWrap={wordWrap}
              onKeyDown={handleEditorKeyDown}
            />
          </Suspense>
        </div>

        {/* 右侧：实时预览区（仅双栏模式） */}
        {editorMode === 'split' && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-neutral-200/30 flex-shrink-0 dark:border-stone-700/30">
              <span className="text-xs font-medium text-neutral-400 dark:text-stone-500">{tr('notesEditor.previewLabel')}</span>
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
