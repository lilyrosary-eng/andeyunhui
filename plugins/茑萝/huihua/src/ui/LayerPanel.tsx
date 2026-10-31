import { useEffect, useRef, useState } from '../host';
import { useEditorState } from '../hooks';
import { editor } from '../store';
import { BLEND_MODES } from '../types';
import { IconCopy, IconDown, IconEye, IconEyeOff, IconMerge, IconPlus, IconTrash, IconUp } from './icons';

function LayerThumb({ id, revision }: { id: string; revision: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 40;
    const H = 32;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const src = editor.getLayerCanvas(id);
    if (!src) return;
    const scale = Math.min(W / src.width, H / src.height);
    const w = src.width * scale;
    const h = src.height * scale;
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }, [id, revision]);
  return <canvas ref={ref} className="h-8 w-10 rounded-sm" style={{ width: 40, height: 32 }} />;
}

export function LayerPanel() {
  const s = useEditorState();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const rows = [...s.layers].reverse();

  const commit = () => {
    if (editingId) editor.renameLayer(editingId, draft);
    setEditingId(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="text-[11px] font-medium text-neutral-400 dark:text-stone-500">
          图层 <span className="tabular-nums">{s.layers.length}</span>
        </span>
        <button
          onClick={() => editor.addLayer()}
          className="btn-press inline-flex items-center gap-0.5 rounded-md bg-[var(--element-bg)] px-1.5 py-0.5 text-[10px] text-white"
          title="新建图层"
        >
          <IconPlus size={11} /> 新建
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
        {rows.map((layer) => {
          const idx = s.layers.findIndex((l) => l.id === layer.id);
          const active = s.activeId === layer.id;
          const canUp = idx >= 0 && idx < s.layers.length - 1;
          const canDown = idx > 0;
          const canDelete = s.layers.length > 1;
          return (
            <div
              key={layer.id}
              onClick={() => editor.selectLayer(layer.id)}
              className={`group rounded-lg px-1.5 py-1.5 transition-colors ${
                active
                  ? 'bg-[var(--element-bg)]/10 ring-1 ring-[var(--element-border)]'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <div className="flex items-start gap-1.5">
                <div className="shrink-0 overflow-hidden rounded-sm border border-black/10 bg-white dark:border-white/10 dark:bg-stone-800">
                  <div
                    style={{
                      backgroundImage:
                        'linear-gradient(45deg,#ddd 25%,transparent 25%),linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),linear-gradient(-45deg,transparent 75%,#ddd 75%)',
                      backgroundSize: '8px 8px',
                      backgroundPosition: '0 0,0 4px,4px -4px,-4px 0',
                    }}
                  >
                    <LayerThumb id={layer.id} revision={s.revision} />
                  </div>
                </div>

                <div className="min-w-0 flex-1">
                  {editingId === layer.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                        if (e.key === 'Escape') setEditingId(null);
                        if (e.key === ' ') e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full rounded border border-[var(--element-border)] bg-white/80 px-1 py-0.5 text-[11px] text-neutral-700 outline-none dark:bg-black/20 dark:text-stone-200"
                    />
                  ) : (
                    <div
                      className="truncate text-[11px] text-neutral-700 dark:text-stone-200"
                      title={`${layer.name}（双击重命名）`}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(layer.id);
                        setDraft(layer.name);
                      }}
                    >
                      {layer.name}
                    </div>
                  )}
                  <select
                    value={layer.blend}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => editor.setLayerBlend(layer.id, e.target.value as typeof layer.blend)}
                    title="混合模式"
                    className="mt-0.5 h-5 w-full rounded border border-black/10 bg-white/70 px-1 text-[10px] text-neutral-600 outline-none dark:border-white/10 dark:bg-black/20 dark:text-stone-300"
                  >
                    {BLEND_MODES.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={layer.opacity}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => editor.setLayerOpacity(layer.id, parseFloat(e.target.value))}
                    title={`不透明度 ${Math.round(layer.opacity * 100)}%`}
                    className="mt-0.5 h-2 w-full accent-emerald-500"
                  />
                </div>

                <button
                  onClick={(e) => { e.stopPropagation(); editor.toggleVisible(layer.id); }}
                  className="mt-0.5 shrink-0 rounded p-1 text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-stone-200"
                  title={layer.visible ? '隐藏图层' : '显示图层'}
                >
                  {layer.visible ? <IconEye size={13} /> : <IconEyeOff size={13} />}
                </button>
              </div>

              <div className={`mt-0.5 flex items-center justify-end gap-0.5 transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                <button
                  disabled={!canUp}
                  onClick={(e) => { e.stopPropagation(); editor.moveLayer(layer.id, 1); }}
                  className="rounded p-1 text-neutral-400 hover:bg-black/5 hover:text-neutral-700 disabled:opacity-25 dark:hover:bg-white/10 dark:hover:text-stone-200"
                  title="上移"
                >
                  <IconUp size={11} />
                </button>
                <button
                  disabled={!canDown}
                  onClick={(e) => { e.stopPropagation(); editor.moveLayer(layer.id, -1); }}
                  className="rounded p-1 text-neutral-400 hover:bg-black/5 hover:text-neutral-700 disabled:opacity-25 dark:hover:bg-white/10 dark:hover:text-stone-200"
                  title="下移"
                >
                  <IconDown size={11} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); editor.duplicateLayer(layer.id); }}
                  className="rounded p-1 text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-stone-200"
                  title="复制图层"
                >
                  <IconCopy size={11} />
                </button>
                <button
                  disabled={!canDown}
                  onClick={(e) => { e.stopPropagation(); editor.mergeDown(layer.id); }}
                  className="rounded p-1 text-neutral-400 hover:bg-black/5 hover:text-neutral-700 disabled:opacity-25 dark:hover:bg-white/10 dark:hover:text-stone-200"
                  title="向下合并"
                >
                  <IconMerge size={11} />
                </button>
                <button
                  disabled={!canDelete}
                  onClick={(e) => { e.stopPropagation(); editor.deleteLayer(layer.id); }}
                  className="rounded p-1 text-neutral-400 hover:bg-black/5 hover:text-red-500 disabled:opacity-25 dark:hover:bg-white/10"
                  title="删除图层"
                >
                  <IconTrash size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
