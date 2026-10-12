import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, Search, Pencil } from 'lucide-react';
import type { ModelUi, ProviderUi } from '../aiConfigCodec';
import { ModelEditorDrawer } from './ModelEditorDrawer';

const ROW_H = 40;

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';
const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

/** 端点是本机回环地址 → 标「本地」，否则「云端」。不引 logo，见规格 §2。 */
function isLocal(baseUrl: string): boolean {
  return /127\.0\.0\.1|localhost|\[::1\]/i.test(baseUrl);
}

function formatContext(n: string): string {
  if (!n) return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}

function capTags(caps: ModelUi['caps'], t: ProviderCardProps['t']): string[] {
  const out: string[] = [];
  if (caps.vision) out.push(t('modelSettings.caps.vision'));
  if (caps.reasoning) out.push(t('modelSettings.caps.reasoning'));
  if (caps.embedding) out.push(t('modelSettings.caps.embedding'));
  else if (caps.text) out.push(t('modelSettings.caps.text'));
  return out;
}

export interface ProviderCardProps {
  provider: ProviderUi;
  expanded: boolean;
  onToggle: () => void;
  /** 供应商内是否有模型被选中 —— 决定标题栏的 ● */
  hasSelected: boolean;
  onSelectModel: (modelId: string) => void;
  onPatchModel: (modelId: string, patch: Partial<ModelUi>) => void;
  onAddModel: () => void;
  onRemoveModel: (modelId: string) => void;
  onOpenDiscover: () => void;
  onPatchProvider: (patch: Partial<ProviderUi>) => void;
  onRemoveProvider: () => void;
  /** 当前被选中的模型 id（来自父级 selection 状态），决定本卡片内每行的 ○/● */
  selectedModelId: string | null;
  /** 搜索命中的模型 id，滚动到它并高亮 */
  highlightModelId: string | null;
  t: (k: string, vars?: Record<string, string | number>) => string;
}

export function ProviderCard(props: ProviderCardProps) {
  const { provider: p, expanded, onToggle, t } = props;
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const q = filter.trim();
  const models = q
    ? p.models.filter((m) => m.model.toLowerCase().includes(q.toLowerCase()) || m.label.toLowerCase().includes(q.toLowerCase()))
    : p.models;

  const virtualizer = useVirtualizer({
    count: models.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const editing = editingId ? p.models.find((m) => m.id === editingId) ?? null : null;

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-stone-700 bg-white/60 dark:bg-stone-900/40">
      {/* 标题栏 */}
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={onToggle} className="flex items-center gap-2 flex-1 min-w-0 text-left" title={t('modelSettings.toggleProvider')}>
          {expanded ? <ChevronDown size={16} className="shrink-0" /> : <ChevronRight size={16} className="shrink-0" />}
          <span className={`shrink-0 ${props.hasSelected ? 'text-[var(--element-border)]' : 'text-neutral-300 dark:text-stone-600'}`}>●</span>
          <span className="truncate font-medium text-sm text-neutral-800 dark:text-stone-100">
            {p.name || t('modelSettings.unnamedProvider')}
          </span>
          <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-stone-800 text-neutral-500 dark:text-stone-400">
            {isLocal(p.base_url) ? t('modelSettings.local') : t('modelSettings.cloud')}
          </span>
        </button>
        <span className="shrink-0 truncate text-[11px] text-neutral-400 dark:text-stone-500 max-w-[40%]" title={p.base_url}>
          {p.base_url || t('modelSettings.noEndpoint')}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-400 dark:text-stone-500">
          {t('modelSettings.modelCount', { n: p.models.length })}
        </span>
        <button
          onClick={props.onOpenDiscover}
          className="shrink-0 p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-stone-800"
          title={t('modelSettings.rescan')}
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={props.onRemoveProvider}
          className="shrink-0 p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-stone-800 text-red-500"
          title={t('modelSettings.removeProvider')}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {expanded && (
        <>
          {/* 端点配置：只在这时候暴露，避免折叠状态下塞满表单 */}
          <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-neutral-100 dark:border-stone-800">
            <div>
              <label className={labelCls}>{t('modelSettings.providerLabel')}</label>
              <input className={inputCls} value={p.name} placeholder={t('modelSettings.unnamedProvider')}
                onChange={(e) => props.onPatchProvider({ name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.endpointLabel')}</label>
              <input className={inputCls} value={p.base_url} placeholder="https://api.deepseek.com/v1"
                onChange={(e) => props.onPatchProvider({ base_url: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.apiKeyLabel')}</label>
              <input className={inputCls} type="password" value={p.api_key} placeholder="sk-..."
                onChange={(e) => props.onPatchProvider({ api_key: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>{t('modelSettings.visionModelLabel')}</label>
                <input className={inputCls} value={p.vision_model}
                  onChange={(e) => props.onPatchProvider({ vision_model: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>{t('modelSettings.imageModel')}</label>
                <input className={inputCls} value={p.image_model}
                  onChange={(e) => props.onPatchProvider({ image_model: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>{t('modelSettings.ttsModel')}</label>
                <input className={inputCls} value={p.tts_model}
                  onChange={(e) => props.onPatchProvider({ tts_model: e.target.value })} />
              </div>
            </div>
          </div>

          {/* 模型表 */}
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  className="w-full pl-7 pr-3 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                  value={filter}
                  placeholder={t('modelSettings.searchModels')}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <button onClick={props.onAddModel}
                className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs border border-neutral-200 dark:border-stone-700 hover:bg-neutral-100 dark:hover:bg-stone-800">
                <Plus size={13} />{t('modelSettings.addModel')}
              </button>
            </div>

            {models.length === 0 ? (
              <div className="py-6 text-center text-xs text-neutral-400">
                {q ? t('modelSettings.noModelMatch') : t('modelSettings.noModels')}
              </div>
            ) : (
              <div ref={scrollRef} className="max-h-[320px] overflow-y-auto rounded-lg border border-neutral-100 dark:border-stone-800">
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((vi) => {
                    const m = models[vi.index];
                    const selected = m.id === props.selectedModelId;
                    const highlighted = m.id === props.highlightModelId;
                    return (
                      <div
                        key={m.id}
                        style={{
                          position: 'absolute', top: 0, left: 0, width: '100%',
                          height: vi.size, transform: `translateY(${vi.start}px)`,
                        }}
                        className={`flex items-center gap-2 px-2.5 border-b border-neutral-100 dark:border-stone-800
                          ${selected ? 'bg-[var(--element-muted)]' : ''}
                          ${highlighted ? 'ring-1 ring-inset ring-[var(--element-border)]' : ''}`}
                      >
                        <button
                          onClick={() => props.onSelectModel(m.id)}
                          className="shrink-0 w-3 text-center"
                          title={selected ? t('modelSettings.selected') : t('modelSettings.selectModel')}
                        >
                          <span className={selected ? 'text-[var(--element-border)]' : 'text-neutral-300 dark:text-stone-600'}>
                            {selected ? '●' : '○'}
                          </span>
                        </button>
                        <span className="flex-1 truncate text-xs font-mono text-neutral-800 dark:text-stone-100" title={m.model}>
                          {m.label || m.model}
                        </span>
                        <span className="shrink-0 text-[11px] text-neutral-400 w-14 text-right">
                          {formatContext(m.context_tokens)}
                        </span>
                        <span className="shrink-0 flex gap-1">
                          {capTags(m.caps, t).map((tag) => (
                            <span key={tag} className="text-[10px] px-1 py-0.5 rounded bg-neutral-100 dark:bg-stone-800 text-neutral-500 dark:text-stone-400">
                              {tag}
                            </span>
                          ))}
                        </span>
                        <button onClick={() => setEditingId(m.id)}
                          className="shrink-0 p-1 rounded hover:bg-neutral-100 dark:hover:bg-stone-800"
                          title={t('modelSettings.editModel')}>
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => props.onRemoveModel(m.id)}
                          className="shrink-0 p-1 rounded hover:bg-neutral-100 dark:hover:bg-stone-800 text-red-500"
                          title={t('modelSettings.removeModel')}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <ModelEditorDrawer
        model={editing}
        onClose={() => setEditingId(null)}
        onSave={(patch) => { if (editing) props.onPatchModel(editing.id, patch); setEditingId(null); }}
        t={t}
      />
    </div>
  );
}
