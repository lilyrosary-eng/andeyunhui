import { X } from 'lucide-react';
import { effectiveEffort, type ModelUi } from '../aiConfigCodec';

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';
const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

/**
 * 容量来源标签——让用户知道这个数字该不该信。
 * 端点是权威值；内置表是近似值；手填是用户自负；`''` 是改造前的老数据（无法区分）。
 */
export function capacitySourceLabel(
  value: string,
  source: string,
  t: (k: string, vars?: Record<string, string | number>) => string,
): string {
  if (!value.trim()) return '';
  switch (source) {
    case 'provider': return t('modelSettings.srcProvider');
    case 'loaded': return t('modelSettings.srcLoaded');
    case 'learned': return t('modelSettings.srcLearned');
    case 'table': return t('modelSettings.srcTable');
    case 'manual': return t('modelSettings.srcManual');
    default: return t('modelSettings.srcUnknown');
  }
}

export interface ModelEditorDrawerProps {
  model: ModelUi | null;
  /** 逐字段实时更新（不关抽屉；由父级自动保存落盘） */
  onPatch: (model: ModelUi) => void;
  onClose: () => void;
  onSave: (patch: Partial<ModelUi>) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}

/** 人设风格预设：选中后作为 system 提示词基底。key 与后端 compose_persona_system 对应。 */
const PERSONA_PRESETS: { key: string; labelKey: string; descKey: string }[] = [
  { key: 'sharp', labelKey: 'persona.sharp', descKey: 'persona.sharp.desc' },
  { key: 'gentle', labelKey: 'persona.gentle', descKey: 'persona.gentle.desc' },
  { key: 'rigorous', labelKey: 'persona.rigorous', descKey: 'persona.rigorous.desc' },
  { key: 'humorous', labelKey: 'persona.humorous', descKey: 'persona.humorous.desc' },
  { key: 'pro', labelKey: 'persona.pro', descKey: 'persona.pro.desc' },
  { key: 'concise', labelKey: 'persona.concise', descKey: 'persona.concise.desc' },
  { key: 'mentor', labelKey: 'persona.mentor', descKey: 'persona.mentor.desc' },
  { key: 'custom', labelKey: 'persona.custom', descKey: 'persona.custom.desc' },
];

/** 单个模型的参数编辑。逐模型覆盖项，与 v1 AiProfile 的同名字段语义一致。 */
export function ModelEditorDrawer(props: ModelEditorDrawerProps) {
  const { model: m, t } = props;
  if (!m) return null;
  // 实时更新走 onPatch（不关抽屉）——旧实现每次输入都走 onSave 触发 setEditingId(null)，
  // 导致打一个字抽屉就闪退，v2 重构上线的隐藏 bug。显式「保存」按钮才走 onSave 关抽屉。
  const set = (patch: Partial<ModelUi>) => props.onPatch({ ...m, ...patch });

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
          {/* 上下文（输入侧）与单次最大输出（输出侧）并列：两者都是「模型能力」，
              与上面的 maxTokens（本次请求要它产多长）语义不同。 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>
                {t('modelSettings.contextTokens')}
                <span className="ml-1.5 text-[10px] text-neutral-400">
                  {capacitySourceLabel(m.context_tokens, m.context_source, t)}
                </span>
              </label>
              <input className={inputCls} value={m.context_tokens} placeholder={t('modelSettings.contextAuto')}
                onChange={(e) => set({
                  context_tokens: e.target.value,
                  // 手改即标 manual → 重扫永不覆盖；清空则撤标，让下次重扫能自动填
                  context_source: e.target.value.trim() ? 'manual' : '',
                })} />
            </div>
            <div>
              <label className={labelCls}>
                {t('modelSettings.maxOutputTokens')}
                <span className="ml-1.5 text-[10px] text-neutral-400">
                  {capacitySourceLabel(m.max_output_tokens, m.max_output_source, t)}
                </span>
              </label>
              <input className={inputCls} value={m.max_output_tokens} placeholder={t('modelSettings.contextAuto')}
                onChange={(e) => set({
                  max_output_tokens: e.target.value,
                  max_output_source: e.target.value.trim() ? 'manual' : '',
                })} />
            </div>
          </div>
          <div>
            <label className={labelCls}>{t('modelSettings.systemPrompt')}</label>
            <textarea className={`${inputCls} min-h-[72px]`} value={m.system_prompt}
              onChange={(e) => set({ system_prompt: e.target.value })} />
          </div>
          {/* 推理档位：只在**供应商上报或兜底表给出的集合**里选——发端点不认识的值会被直接 400。
              集合为空（老配置）时退化为原来的布尔开关，行为与改造前一致。 */}
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <label className={`${labelCls} mb-0`}>{t('modelSettings.reasoningEffort')}</label>
              {m.reasoning.efforts.length > 0 && (
                <span className="text-[10px] text-neutral-400">
                  {m.reasoning.from_provider ? t('modelSettings.effortFromProvider') : t('modelSettings.effortFromBuiltin')}
                </span>
              )}
            </div>
            {m.reasoning.efforts.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {m.reasoning.efforts.map((e) => {
                  const on = effectiveEffort(m) === e.id.toLowerCase();
                  return (
                    <button key={e.id} type="button"
                      onClick={() => set({ reasoning_effort: e.id, thinking: e.id.toLowerCase() !== 'off' })}
                      className={`px-2.5 py-1 rounded-full text-[11px] border transition-colors ${
                        on
                          ? 'border-[var(--element-border)] bg-[rgba(230,195,92,0.14)] text-neutral-800 dark:text-stone-100 font-medium'
                          : 'border-neutral-200 dark:border-stone-700 text-neutral-600 dark:text-stone-300 hover:border-neutral-300'
                      }`}>
                      {e.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-stone-300 mt-1">
                <input type="checkbox" checked={m.thinking}
                  onChange={(e) => set({ thinking: e.target.checked, reasoning_effort: '' })} />
                {t('modelSettings.thinking')}
              </label>
            )}
          </div>

          {/* 人设（称呼 / 风格预设 / 自定义风格）——v2 重构漏搬，现按旧桌面设计恢复。
              字段已在 ModelUi schema + toModel 序列化里，此处仅补编辑 UI；系统提示词在下方单独编辑。 */}
          <div className="pt-2 border-t border-neutral-100 dark:border-stone-800 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-neutral-500 dark:text-stone-400">{t('modelSettings.persona')}</span>
              <span className="text-[11px] text-neutral-400">{t('modelSettings.personaDesc')}</span>
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.callMeAs')}</label>
              <input className={inputCls} value={m.persona_call_me_as}
                placeholder={t('modelSettings.callMeAsPlaceholder')}
                onChange={(e) => set({ persona_call_me_as: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.personaStyle')}</label>
              <div className="flex flex-wrap gap-1.5">
                {PERSONA_PRESETS.map((p) => (
                  <button key={p.key} type="button" onClick={() => set({ persona_preset: p.key })}
                    className={`px-2.5 py-1 rounded-full text-[11px] border transition-colors ${
                      m.persona_preset === p.key
                        ? 'border-[var(--element-border)] bg-[rgba(230,195,92,0.14)] text-neutral-800 dark:text-stone-100 font-medium'
                        : 'border-neutral-200 dark:border-stone-700 text-neutral-600 dark:text-stone-300 hover:border-neutral-300'
                    }`}>
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-neutral-400">
                {PERSONA_PRESETS.find((p) => p.key === m.persona_preset)
                  ? t(PERSONA_PRESETS.find((p) => p.key === m.persona_preset)!.descKey)
                  : t('persona.noPreset')}
              </p>
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.customStyle')}</label>
              <textarea className={`${inputCls} resize-none`} rows={2} value={m.persona_style}
                placeholder={t('modelSettings.customStylePlaceholder')}
                onChange={(e) => set({ persona_style: e.target.value })} />
            </div>
          </div>

          <div className="pt-2 border-t border-neutral-100 dark:border-stone-800">
            <div className="text-[11px] font-medium text-neutral-500 dark:text-stone-400 mb-2">
              {t('modelSettings.capabilities')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['text', 'vision', 'reasoning', 'tools', 'embedding'] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 text-xs text-neutral-700 dark:text-stone-300">
                  <input type="checkbox" checked={m.caps[k]}
                    onChange={(e) => set({
                      caps: {
                        ...m.caps,
                        [k]: e.target.checked,
                        // 手改能力位 → 标 manual（重扫/探测都不得覆盖），与容量字段的
                        // 手改口径一致。不标的话下次重扫会用名字启发式把它冲掉 ——
                        // 而用户改它，往往正是因为他不信我们的推断
                        // （比如某个名字里没有线索、但实际支持视觉的模型）。
                        ...(k === 'vision' ? { vision_source: 'manual' as const } : {}),
                        ...(k === 'tools' ? { tools_source: 'manual' as const } : {}),
                        ...(k === 'embedding' ? { embedding_source: 'manual' as const } : {}),
                      },
                    })} />
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
