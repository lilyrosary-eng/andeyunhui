import { useEditorState } from '../hooks';
import { editor } from '../store';
import { cx } from '../host';
import { IconDownload, IconFolderOpen, IconImage, IconPanelRight, IconPlus, IconSave } from './icons';

const btn =
  'btn-press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ' +
  'text-neutral-600 hover:bg-black/5 dark:text-stone-300 dark:hover:bg-white/10';

export function DocBar() {
  const s = useEditorState();
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/70 px-3 dark:border-stone-700/50">
      <span className="text-[11px] text-neutral-400 dark:text-stone-500">茑萝</span>
      <span className="text-[11px] text-neutral-300 dark:text-stone-600">/</span>
      <span className="text-[12px] font-medium text-neutral-700 dark:text-stone-200">绘画</span>
      <span className="mx-2 h-4 w-px bg-black/10 dark:bg-white/10" />
      <span
        className="max-w-[200px] cursor-text truncate text-[12px] font-medium text-neutral-700 dark:text-stone-200"
        title={`${s.doc.name}（双击重命名）`}
        onDoubleClick={() => {
          const next = window.prompt('文档名称', s.doc.name);
          if (next) editor.renameDocument(next);
        }}
      >
        {s.doc.name}
      </span>
      {s.doc.dirty && <span className="text-[13px] leading-none text-amber-500" title="有未保存修改">●</span>}
      <span className="text-[10px] tabular-nums text-neutral-400 dark:text-stone-500">
        {s.doc.w} × {s.doc.h}
      </span>
      <span className="flex-1" />
      <button className={btn} onClick={() => editor.newDocument()} title="新建画布">
        <IconPlus size={13} />
        <span className="hidden md-win:inline">新建</span>
      </button>
      <button className={btn} onClick={() => void editor.openProject()} title="打开项目 (Ctrl+O)">
        <IconFolderOpen size={13} />
        <span className="hidden md-win:inline">打开</span>
      </button>
      <button className={btn} onClick={() => void editor.saveProject()} title="保存项目 (Ctrl+S)">
        <IconSave size={13} />
        <span className="hidden md-win:inline">保存</span>
      </button>
      <button className={btn} onClick={() => editor.importImage()} title="导入图片为图层">
        <IconImage size={13} />
        <span className="hidden md-win:inline">导入</span>
      </button>
      <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" />
      <button className={btn} onClick={() => void editor.exportImg('png')} title="导出 PNG 到中转站">
        <IconDownload size={13} />
        <span className="hidden md-win:inline">PNG</span>
      </button>
      <button className={btn} onClick={() => void editor.exportImg('jpeg')} title="导出 JPG 到中转站">
        <IconDownload size={13} />
        <span className="hidden md-win:inline">JPG</span>
      </button>
      <button
        className={cx(btn, !s.rightDockCollapsed && 'bg-black/5 dark:bg-white/10')}
        onClick={() => editor.toggleRightDock()}
        title={s.rightDockCollapsed ? '展开属性栏' : '收起属性栏'}
      >
        <IconPanelRight size={13} />
      </button>
    </div>
  );
}
