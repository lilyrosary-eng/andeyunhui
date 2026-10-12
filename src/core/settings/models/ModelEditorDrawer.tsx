import { X } from 'lucide-react';
import type { ModelUi } from '../aiConfigCodec';

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';
const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

export interface ModelEditorDrawerProps {
  model: ModelUi | null;
  onClose: () => void;
  onSave: (patch: Partial<ModelUi>) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}

/** 单个模型的参数编辑。逐模型覆盖项，与 v1 AiProfile 的同名字段语义一致。 */
export function ModelEditorDrawer(props: ModelEditorDrawerProps) {
  const { model: m, t } = props;
  if (!m) return null;
  const set = (patch: Partial<ModelUi>) => props.onSave({ ...m, ...patch });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={props.onClose}>
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 p-5"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100">
            {t('modelSettings.editModelTitle', { name: m.label || m.model })}
          </h3>
          <button onClick={props.onClose} className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-stone-800">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelCls}>{t('modelSettings.modelId')}</label>
            <input className={inputCls} value={m.model} onChange={(e) => set({ model: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>{t('modelSettings.displayName')}</label>
            <input className={inputCls} value={m.label} placeholder={m.model}
              onChange={(e) => set({ label: e.target.value })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>{t('modelSettings.temperature')}</label>
              <input className={inputCls} value={m.temperature} placeholder="0.3"
                onChange={(e) => set({ temperature: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.topP')}</label>
              <input className={inputCls} value={m.top_p} placeholder="0~1"
                onChange={(e) => set({ top_p: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.maxTokens')}</label>
              <input className={inputCls} value={m.max_tokens}
                onChange={(e) => set({ max_tokens: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls}>{t('modelSettings.contextTokens')}</label>
            <input className={inputCls} value={m.context_tokens} placeholder={t('modelSettings.contextAuto')}
              onChange={(e) => set({ context_tokens: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>{t('modelSettings.systemPrompt')}</label>
            <textarea className={`${inputCls} min-h-[72px]`} value={m.system_prompt}
              onChange={(e) => set({ system_prompt: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-stone-300">
            <input type="checkbox" checked={m.thinking} onChange={(e) => set({ thinking: e.target.checked })} />
            {t('modelSettings.thinking')}
          </label>

          <div className="pt-2 border-t border-neutral-100 dark:border-stone-800">
            <div className="text-[11px] font-medium text-neutral-500 dark:text-stone-400 mb-2">
              {t('modelSettings.capabilities')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['text', 'vision', 'reasoning', 'embedding'] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 text-xs text-neutral-700 dark:text-stone-300">
                  <input type="checkbox" checked={m.caps[k]}
                    onChange={(e) => set({ caps: { ...m.caps, [k]: e.target.checked } })} />
                  {t(`modelSettings.caps.${k}`)}
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-neutral-400">{t('modelSettings.capsHint')}</p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={props.onClose}
            className="px-3 py-1.5 rounded-lg text-sm border border-neutral-200 dark:border-stone-700">
            {t('modelSettings.cancel')}
          </button>
          <button onClick={() => props.onSave(m)}
            className="px-3 py-1.5 rounded-lg text-sm bg-[var(--element-border)] text-white">
            {t('modelSettings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
