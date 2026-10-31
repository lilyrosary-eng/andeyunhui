import { useEditorState } from '../../hooks';
import { editor } from '../../store';
import { TOOLS } from '../../types';

export function ToolPanel() {
  const s = useEditorState();
  return (
    <div className="grid grid-cols-4 gap-1">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => editor.setTool(t.id)}
          title={`${t.label} (${t.key})`}
          className={`rounded-md py-1.5 text-[10px] font-medium transition-all ${
            s.tool === t.id
              ? 'bg-[var(--element-bg)] text-white shadow-sm'
              : 'bg-black/5 text-neutral-600 hover:bg-black/10 dark:bg-white/5 dark:text-stone-300 dark:hover:bg-white/10'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
