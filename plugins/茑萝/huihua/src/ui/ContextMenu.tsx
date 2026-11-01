import { useEffect } from '../host';
import { useEditorState } from '../hooks';
import { editor } from '../store';

const item =
  'flex w-full items-center justify-between gap-6 rounded px-2.5 py-1.5 text-left text-[11px] ' +
  'text-neutral-600 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-35 dark:text-stone-300 dark:hover:bg-white/10';

export function ContextMenu() {
  const s = useEditorState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') editor.closeContextMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!s.contextMenu) return null;
  const width = 188;
  const height = 500;
  const left = Math.max(8, Math.min(s.contextMenu.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(s.contextMenu.y, window.innerHeight - height - 8));

  const run = (fn: () => void) => {
    fn();
    editor.closeContextMenu();
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onPointerDown={() => editor.closeContextMenu()}
      onContextMenu={(e) => { e.preventDefault(); editor.closeContextMenu(); }}
    >
      <div
        className="absolute w-[188px] rounded-lg border border-black/10 bg-white/95 p-1 shadow-xl backdrop-blur dark:border-white/10 dark:bg-stone-900/95"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button className={item} disabled={!s.canUndo} onClick={() => run(() => editor.undo())}>
          <span>撤销</span><span className="text-[10px] text-neutral-400">Ctrl+Z</span>
        </button>
        <button className={item} disabled={!s.canRedo} onClick={() => run(() => editor.redo())}>
          <span>重做</span><span className="text-[10px] text-neutral-400">Ctrl+Shift+Z</span>
        </button>
        <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
        <button className={item} onClick={() => run(() => void editor.openProject())}>
          <span>打开项目</span><span className="text-[10px] text-neutral-400">Ctrl+O</span>
        </button>
        <button className={item} onClick={() => run(() => void editor.saveProject())}>
          <span>保存项目</span><span className="text-[10px] text-neutral-400">Ctrl+S</span>
        </button>
        <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
        <button className={item} onClick={() => run(() => editor.selectAll())}>
          <span>全选</span><span className="text-[10px] text-neutral-400">Ctrl+A</span>
        </button>
        <button className={item} onClick={() => run(() => editor.invertSelection())}>
          <span>反选</span><span className="text-[10px] text-neutral-400">Ctrl+Shift+I</span>
        </button>
        <button className={item} disabled={!s.hasSelection} onClick={() => run(() => editor.clearSelection())}>
          <span>取消选区</span><span className="text-[10px] text-neutral-400">Ctrl+D</span>
        </button>
        <button className={item} disabled={!s.hasSelection} onClick={() => run(() => editor.deleteSelection())}>
          <span>删除选区内容</span><span className="text-[10px] text-neutral-400">Delete</span>
        </button>
        <button className={item} disabled={!s.hasSelection} onClick={() => run(() => editor.cutSelection())}>
          <span>剪切</span><span className="text-[10px] text-neutral-400">Ctrl+X</span>
        </button>
        <button className={item} onClick={() => run(() => editor.copySelection())}>
          <span>复制</span><span className="text-[10px] text-neutral-400">Ctrl+C</span>
        </button>
        <button className={item} disabled={!s.hasClipboard} onClick={() => run(() => editor.pasteClipboard())}>
          <span>粘贴</span><span className="text-[10px] text-neutral-400">Ctrl+V</span>
        </button>
        <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
        <button className={item} onClick={() => run(() => editor.clearLayer())}>
          <span>清空当前图层</span>
        </button>
        <button className={item} onClick={() => run(() => editor.fitView())}>
          <span>适应窗口</span><span className="text-[10px] text-neutral-400">Ctrl+0</span>
        </button>
        <button className={item} onClick={() => run(() => editor.zoomTo(1))}>
          <span>实际大小</span><span className="text-[10px] text-neutral-400">Ctrl+1</span>
        </button>
        <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
        <button className={item} onClick={() => run(() => void editor.exportImg('png'))}>
          <span>导出 PNG</span>
        </button>
        <button className={item} onClick={() => run(() => void editor.exportImg('jpeg'))}>
          <span>导出 JPG</span>
        </button>
        <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
        <button className={item} onClick={() => run(() => editor.toggleQuickbar())}>
          <span>{s.quickbarVisible ? '隐藏快捷栏' : '显示快捷栏'}</span>
        </button>
      </div>
    </div>
  );
}
