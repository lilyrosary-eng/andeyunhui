import { useEditorCursor, useEditorState } from '../hooks';
import { editor } from '../store';
import { TOOLS } from '../types';

export function StatusBar() {
  const s = useEditorState();
  const cursor = useEditorCursor();
  const tool = TOOLS.find((t) => t.id === s.tool);
  const memory = editor.getMemoryMb();
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-white/70 px-3 text-[10px] tabular-nums text-neutral-500 dark:border-stone-700/50 dark:text-stone-400">
      <span className="text-neutral-600 dark:text-stone-300">{tool?.label ?? '画笔'}</span>
      <span>{s.size} px</span>
      <span className="text-neutral-300 dark:text-stone-600">|</span>
      <span>{s.doc.w} × {s.doc.h}</span>
      <span className="text-neutral-300 dark:text-stone-600">|</span>
      <span className="w-24 truncate">
        {cursor.inside ? `X ${Math.floor(cursor.x)}  Y ${Math.floor(cursor.y)}` : 'X —  Y —'}
      </span>
      <span className="text-neutral-300 dark:text-stone-600">|</span>
      <span>{Math.round(s.zoom * 100)}%</span>
      <span className="text-neutral-300 dark:text-stone-600">|</span>
      <span>{s.layers.length} 层 · {memory < 1 ? '<1' : Math.round(memory)} MB</span>
      {s.hasSelection && (
        <>
          <span className="text-neutral-300 dark:text-stone-600">|</span>
          <span>选区 {s.selectionW} × {s.selectionH}{s.feather > 0 ? ` · 羽化 ${s.feather}px` : ''}</span>
        </>
      )}
      {cursor.pressure > 0 && (
        <span className="flex items-center gap-1" title={`压感 ${Math.round(cursor.pressure * 100)}%`}>
          <span className="text-neutral-300 dark:text-stone-600">|</span>
          <span>压感</span>
          <span className="h-1.5 w-10 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <span
              className="block h-full rounded-full bg-[var(--element-bg)]"
              style={{ width: `${Math.round(cursor.pressure * 100)}%` }}
            />
          </span>
        </span>
      )}
      <span className="flex-1" />
      <span className="max-w-[45%] truncate text-neutral-400 dark:text-stone-500">{s.status}</span>
    </div>
  );
}
