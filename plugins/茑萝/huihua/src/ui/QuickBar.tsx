import { useEditorState } from '../hooks';
import { editor } from '../store';
import { cx } from '../host';
import { IconFit, IconRedo, IconUndo, IconZoomIn, IconZoomOut } from './icons';

const chip =
  'btn-press inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[11px] tabular-nums ' +
  'text-neutral-600 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-35 dark:text-stone-300 dark:hover:bg-white/10';
const activeChip = 'bg-[var(--element-bg)] text-white hover:bg-[var(--element-bg)]';

export function QuickBar() {
  const s = useEditorState();
  return (
    <div className="absolute left-3 top-3 z-20 flex items-center gap-0.5 rounded-xl border border-black/10 bg-white/85 px-1.5 py-1 shadow-lg backdrop-blur dark:border-white/10 dark:bg-stone-900/80">
      <button
        className={cx(chip, s.tool === 'pen' && activeChip)}
        onClick={() => editor.setTool('pen')}
        title="画笔 (B)"
      >
        画笔
      </button>
      <button
        className={cx(chip, s.tool === 'eraser' && activeChip)}
        onClick={() => editor.setTool('eraser')}
        title="橡皮 (E)"
      >
        橡皮
      </button>
      <span className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />
      <button className={chip} onClick={() => editor.setSize(s.size - 1)} title="减小笔刷 ([)">−</button>
      <span className="w-9 text-center text-[11px] tabular-nums text-neutral-600 dark:text-stone-300" title="笔刷粗细">
        {s.size}px
      </span>
      <button className={chip} onClick={() => editor.setSize(s.size + 1)} title="增大笔刷 (])">＋</button>
      <span className="px-1 text-[10px] tabular-nums text-neutral-400 dark:text-stone-500" title="不透明度">
        {Math.round(s.opacity * 100)}%
      </span>
      <span className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />
      <button className={chip} onClick={() => editor.undo()} disabled={!s.canUndo} title="撤销 (Ctrl+Z)">
        <IconUndo size={14} />
      </button>
      <button className={chip} onClick={() => editor.redo()} disabled={!s.canRedo} title="重做 (Ctrl+Shift+Z)">
        <IconRedo size={14} />
      </button>
      <span className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />
      <button className={chip} onClick={() => editor.zoomBy(1 / 1.15)} title="缩小 (Ctrl+-)">
        <IconZoomOut size={14} />
      </button>
      <button className={cx(chip, 'w-12')} onClick={() => editor.zoomTo(1)} title="100% (Ctrl+1)">
        {Math.round(s.zoom * 100)}%
      </button>
      <button className={chip} onClick={() => editor.zoomBy(1.15)} title="放大 (Ctrl+=)">
        <IconZoomIn size={14} />
      </button>
      <button className={chip} onClick={() => editor.fitView()} title="适应窗口 (Ctrl+0)">
        <IconFit size={14} />
      </button>
    </div>
  );
}
