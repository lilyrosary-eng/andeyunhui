import { useEffect, useRef } from '../host';
import { useEditorState } from '../hooks';
import { editor } from '../store';
import { Board } from './Board';
import { ContextMenu } from './ContextMenu';
import { DocBar } from './DocBar';
import { IconPanelRight } from './icons';
import { QuickBar } from './QuickBar';
import { RightDock } from './RightDock';
import { StatusBar } from './StatusBar';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function EditorShell() {
  const s = useEditorState();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const visible = (): boolean => {
      const el = rootRef.current;
      return !!el && el.isConnected && el.getClientRects().length > 0;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!visible()) return;
      if (e.key === 'Escape') {
        editor.closeContextMenu();
        editor.clearSelection();
        return;
      }
      if (isTypingTarget(e.target)) return;

      if (e.code === 'Space') {
        if (!e.repeat) editor.setSpace(true);
        e.preventDefault();
        return;
      }
      if (e.code === 'Tab') {
        e.preventDefault();
        editor.toggleChrome();
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) editor.redo();
          else editor.undo();
          return;
        }
        if (key === 'y') { e.preventDefault(); editor.redo(); return; }
        if (key === '0') { e.preventDefault(); editor.fitView(); return; }
        if (key === '1') { e.preventDefault(); editor.zoomTo(1); return; }
        if (key === '=' || key === '+') { e.preventDefault(); editor.zoomBy(1.15); return; }
        if (key === '-') { e.preventDefault(); editor.zoomBy(1 / 1.15); return; }
        if (key === 's') { e.preventDefault(); void editor.saveProject(); return; }
        if (key === 'o') { e.preventDefault(); void editor.openProject(); return; }
        if (key === 'a') { e.preventDefault(); editor.selectAll(); return; }
        if (key === 'i' && e.shiftKey) { e.preventDefault(); editor.invertSelection(); return; }
        if (key === 'd') { e.preventDefault(); editor.clearSelection(); return; }
        if (key === 'c') { e.preventDefault(); editor.copySelection(); return; }
        if (key === 'v') { e.preventDefault(); editor.pasteClipboard(); return; }
        if (key === 'x') { e.preventDefault(); editor.cutSelection(); return; }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'b': editor.setTool('pen'); break;
        case 'e': editor.setTool('eraser'); break;
        case 'g': editor.setTool('fill'); break;
        case 'i': editor.setTool('pick'); break;
        case 'r': editor.setTool('rect'); break;
        case 'o': editor.setTool('ellipse'); break;
        case 'l': editor.setTool('line'); break;
        case 'a': if (e.shiftKey) editor.setTool('arrow'); break;
        case 'm': editor.setTool('selectRect'); break;
        case 'q': editor.setTool('selectLasso'); break;
        case 'v': editor.setTool('move'); break;
        case '[': editor.setSize(editor.getState().size - 1); break;
        case ']': editor.setSize(editor.getState().size + 1); break;
        case 'x': editor.swapColors(); break;
        case 'delete':
        case 'backspace':
          e.preventDefault();
          editor.deleteSelection();
          break;
        default: break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') editor.setSpace(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full min-h-0 select-none bg-[#f5f5f0] text-neutral-700 dark:bg-[#1c1917] dark:text-stone-200"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {s.chromeVisible && <DocBar />}
        <div className="relative min-h-0 flex-1">
          <Board />
          {s.chromeVisible && s.quickbarVisible && <QuickBar />}
          {!s.chromeVisible && (
            <button
              onClick={() => editor.toggleChrome()}
              className="absolute right-3 top-3 z-20 inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white/85 px-2 py-1 text-[10px] text-neutral-600 shadow backdrop-blur dark:border-white/10 dark:bg-stone-900/80 dark:text-stone-300"
              title="显示界面 (Tab)"
            >
              <IconPanelRight size={12} />
              显示界面
            </button>
          )}
          {s.contextMenu && <ContextMenu />}
        </div>
        {s.chromeVisible && <StatusBar />}
      </div>
      {s.chromeVisible && <RightDock />}
    </div>
  );
}
