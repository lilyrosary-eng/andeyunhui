import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useState } from '../host';
import { useEditorState } from '../hooks';
import { editor } from '../store';
import { IconBrush, IconChevron, IconClose, IconPalette, IconPanelRight } from './icons';
import { ColorPanel } from './panels/ColorPanel';
import { ToolPanel } from './panels/ToolPanel';
import { BrushPanel } from './panels/BrushPanel';

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-black/5 bg-white/45 dark:border-white/10 dark:bg-white/[.03]">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-2 py-1.5 text-[11px] font-medium text-neutral-600 hover:bg-black/[.03] dark:text-stone-300 dark:hover:bg-white/[.04]"
      >
        <span>{title}</span>
        <IconChevron size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

export function RightDock() {
  const s = useEditorState();
  const [open, setOpen] = useState({ selection: true, color: true, tools: true, brush: true });

  if (s.rightDockCollapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-white/70 bg-[#f5f5f0]/80 py-2 dark:border-stone-700/50 dark:bg-[#1c1917]/80">
        <button
          className="btn-press rounded-md p-2 text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
          onClick={() => editor.toggleRightDock()}
          title="展开属性栏"
        >
          <IconPanelRight size={15} />
        </button>
        <span className="my-1 h-px w-6 bg-black/10 dark:bg-white/10" />
        <button className="btn-press rounded-md p-2 text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10" onClick={() => editor.toggleRightDock()} title="颜色">
          <IconPalette size={15} />
        </button>
        <button className="btn-press rounded-md p-2 text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10" onClick={() => editor.toggleRightDock()} title="工具">
          <IconBrush size={15} />
        </button>
      </aside>
    );
  }

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = s.rightDockWidth;
    const move = (ev: PointerEvent) => editor.setRightDockWidth(startW - (ev.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside
      style={{ width: s.rightDockWidth }}
      className="relative flex shrink-0 flex-col border-l border-white/70 bg-[#f5f5f0]/80 dark:border-stone-700/50 dark:bg-[#1c1917]/80"
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-black/5 px-2 dark:border-white/5">
        <span className="text-[11px] font-medium text-neutral-500 dark:text-stone-400">属性</span>
        <button
          className="btn-press rounded-md p-1.5 text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-stone-200"
          onClick={() => editor.toggleRightDock()}
          title="收起属性栏"
        >
          <IconClose size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
        <Section title="选区" open={open.selection} onToggle={() => setOpen((v) => ({ ...v, selection: !v.selection }))}>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-8 shrink-0 text-[10px] text-neutral-500 dark:text-stone-400">羽化</span>
              <input
                type="range"
                min={0}
                max={50}
                step={1}
                value={s.feather}
                onChange={(e) => editor.setFeather(parseInt(e.target.value, 10))}
                className="flex-1 accent-emerald-500"
              />
              <span className="w-8 text-right text-[10px] tabular-nums text-neutral-400 dark:text-stone-500">{s.feather}px</span>
            </div>
            <div className="flex gap-1">
              <button
                className="flex-1 rounded border border-black/10 px-1 py-0.5 text-[10px] text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/10"
                onClick={() => editor.selectAll()}
              >
                全选
              </button>
              <button
                className="flex-1 rounded border border-black/10 px-1 py-0.5 text-[10px] text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/10"
                onClick={() => editor.invertSelection()}
              >
                反选
              </button>
              <button
                className="flex-1 rounded border border-black/10 px-1 py-0.5 text-[10px] text-neutral-500 hover:bg-black/5 disabled:opacity-30 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/10"
                disabled={!s.hasSelection}
                onClick={() => editor.clearSelection()}
              >
                取消
              </button>
            </div>
            <div className="text-[10px] text-neutral-400 dark:text-stone-500">
              {s.hasSelection ? `选区 ${s.selectionW} × ${s.selectionH}` : '无选区'}
            </div>
          </div>
        </Section>
        <Section title="颜色" open={open.color} onToggle={() => setOpen((v) => ({ ...v, color: !v.color }))}>
          <ColorPanel />
        </Section>
        <Section title="工具" open={open.tools} onToggle={() => setOpen((v) => ({ ...v, tools: !v.tools }))}>
          <ToolPanel />
        </Section>
        <Section title="笔刷" open={open.brush} onToggle={() => setOpen((v) => ({ ...v, brush: !v.brush }))}>
          <BrushPanel />
        </Section>
      </div>
      <div
        onPointerDown={startResize}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-[var(--element-bg)]/30"
        title="拖动调整宽度"
      />
    </aside>
  );
}
