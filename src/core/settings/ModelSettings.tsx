import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useI18n } from '@/lib/i18n';
import {
  Cpu, Server, KeyRound, Bot, SlidersHorizontal, TestTube2, Check, X, Plus,
  ChevronDown, ChevronUp, RotateCcw, Eye, EyeOff, Trash2, Star, ExternalLink,
} from 'lucide-react';

// ============ 模型档案（前端编辑态） ============
interface ProfileUi {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  vision_model: string;
  temperature: number;
  max_tokens: string;
  top_p: string;
  system_prompt: string;
  thinking: boolean;
  persona_call_me_as: string;
  persona_preset: string;
  persona_style: string;
}

// 主流 OpenAI 兼容供应商预设（一键填充端点与推荐模型）
// visionModels：该供应商支持视觉（图片 OCR / 理解）的模型，留空表示无视觉模型。
// 多数供应商的「对话模型」并不带视觉能力，OCR 需单独指定视觉模型，否则会报「模型不支持图片」。
const PROVIDERS: { id: string; name: string; base_url: string; models: string[]; visionModels: string[] }[] = [
  { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'], visionModels: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'gpt-5.6'], visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5.6'] },
  { id: 'custom', name: 'Custom', base_url: '', models: [], visionModels: [] },
  { id: 'qwen', name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-3.5-plus', 'qwen2.5-coder-32b-instruct', 'qwen3-coder-plus'], visionModels: ['qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct', 'qwen2.5-vl-32b-instruct'] },
  { id: 'zhipu', name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-5.1', 'glm-5.2'], visionModels: ['glm-4v-plus', 'glm-4v', 'glm-4v-flash'] },
  { id: 'ollama', name: 'Ollama (local)', base_url: 'http://localhost:11434/v1', models: ['llama3', 'qwen2.5', 'codellama', 'deepseek-coder'], visionModels: ['llava', 'llama3.2-vision', 'qwen2.5vl:7b'] },
];

// 所有供应商模型聚合，作为模型名输入的联想建议
const ALL_MODELS = Array.from(new Set(PROVIDERS.flatMap((p) => p.models)));
// 所有视觉模型聚合，作为视觉模型输入的联想建议
const ALL_VISION_MODELS = Array.from(new Set(PROVIDERS.flatMap((p) => p.visionModels)));

// 人设风格预设：选中后作为 system 提示词基底（可在「自定义风格」中追加/覆盖）。key 与后端 compose_persona_system 对应。
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

function defaultProfile(name = 'DeepSeek'): ProfileUi {
  const p = PROVIDERS.find((x) => x.name === name) || PROVIDERS[0];
  return {
    id: 'p_' + Math.random().toString(36).slice(2, 8),
    name: p.name,
    base_url: p.base_url,
    api_key: '',
    model: p.models[0] || '',
    vision_model: '',
    temperature: 0.3,
    max_tokens: '',
    top_p: '',
    system_prompt: '',
    thinking: false,
    persona_call_me_as: '',
    persona_preset: '',
    persona_style: '',
  };
}

function fromPayload(p: any): ProfileUi {
  return {
    id: p.id || 'p_' + Math.random().toString(36).slice(2, 8),
    name: p.name || '',
    base_url: p.base_url || '',
    api_key: p.api_key || '',
    model: p.model || '',
    vision_model: p.vision_model || '',
    temperature: typeof p.temperature === 'number' ? p.temperature : 0.3,
    max_tokens: p.max_tokens != null ? String(p.max_tokens) : '',
    top_p: p.top_p != null ? String(p.top_p) : '',
    system_prompt: p.system_prompt || '',
    thinking: p.thinking === true,
    persona_call_me_as: p.persona_call_me_as || '',
    persona_preset: p.persona_preset || '',
    persona_style: p.persona_style || '',
  };
}

function toPayload(p: ProfileUi) {
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    api_key: p.api_key,
    model: p.model,
    vision_model: p.vision_model.trim() ? p.vision_model.trim() : null,
    temperature: p.temperature,
    max_tokens: p.max_tokens.trim() ? Math.max(1, parseInt(p.max_tokens, 10) || 0) : null,
    top_p: p.top_p.trim() ? Math.min(1, Math.max(0, parseFloat(p.top_p) || 0)) : null,
    system_prompt: p.system_prompt.trim() ? p.system_prompt.trim() : null,
    thinking: p.thinking === true ? true : null,
    persona_call_me_as: p.persona_call_me_as.trim() ? p.persona_call_me_as.trim() : null,
    persona_preset: p.persona_preset.trim() ? p.persona_preset.trim() : null,
    persona_style: p.persona_style.trim() ? p.persona_style.trim() : null,
  };
}

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';

const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

export function ModelSettings() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<ProfileUi[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const [showKey, setShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const editProfile = profiles.find((p) => p.id === editId) || null;

  // 启动时从 Rust 读取已保存的全部模型档案（兼容旧版单配置自动升级为单档案）
  useEffect(() => {
    invoke<{ profiles: any[]; active: string | null }>('ai_get_profiles')
      .then((data) => {
        const list = (data.profiles || []).map(fromPayload);
        setProfiles(list);
        if (list.length === 0) {
          // 未配置任何模型：不预置假档案，直接展示空状态，引导用户「添加模型档案」
          setActiveId(null);
          setEditId(null);
        } else {
          const act = data.active && list.some((p) => p.id === data.active) ? data.active : list[0].id;
          setActiveId(act);
          setEditId(list[0].id);
        }
      })
      .catch((e) => {
        console.warn('[模型] 读取配置失败:', e);
        const d = defaultProfile();
        setProfiles([d]);
        setActiveId(d.id);
        setEditId(d.id);
      });
  }, []);

  // 自动持久化：任何配置变更（含「设为默认」、预设新增、字段编辑）都在 800ms 后静默落盘，
  // 避免「忘了点保存全部」导致配置丢失。首屏从 Rust 读取后不触发写入。
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    if (profiles.length === 0) return;
    const timer = setTimeout(() => {
      invoke('ai_set_profiles', {
        payload: { profiles: profiles.map(toPayload), active: activeId },
      }).catch((e) => console.warn('[模型] 自动保存失败:', e));
    }, 800);
    return () => clearTimeout(timer);
  }, [profiles, activeId]);

  const updateProfile = useCallback((id: string, patch: Partial<ProfileUi>) => {
    setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const triggerSaved = useCallback(() => {
    setSavedAt(true);
    setTimeout(() => setSavedAt(false), 1800);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await invoke('ai_set_profiles', {
        payload: { profiles: profiles.map(toPayload), active: activeId },
      });
      triggerSaved();
      setTestMsg(null);
    } catch (e) {
      setTestMsg({ ok: false, text: t('settings.saveFailed', { err: String(e) }) });
    } finally {
      setSaving(false);
    }
  }, [profiles, activeId, triggerSaved]);

  const handleTest = useCallback(async () => {
    if (!editProfile) return;
    if (!editProfile.api_key.trim()) {
      setTestMsg({ ok: false, text: t('modelSettings.needApiKey') });
      return;
    }
    if (!/^https?:\/\//.test(editProfile.base_url.trim())) {
      setTestMsg({ ok: false, text: t('modelSettings.badEndpoint') });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await invoke<string>('ai_test_connection', { config: toPayload(editProfile) });
      setTestMsg({ ok: true, text: res });
    } catch (e) {
      setTestMsg({ ok: false, text: t('modelSettings.connFailed', { err: String(e) }) });
    } finally {
      setTesting(false);
    }
  }, [editProfile]);

  // 供应商预设：保护已配置档案，绝不覆盖。
  // - 若当前档案仍是空白（刚添加、尚未填任何连接信息），则用预设填充，方便从预设起步；
  // - 若当前档案已配置（填过端点 / Key / 模型 / 视觉模型任一），则新建一份该供应商档案，
  //   已配好的那份原封不动，避免「手滑点了一下预设，辛苦配的没了」。
  const selectProvider = useCallback((id: string) => {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    const isBlank =
      !editProfile ||
      (!editProfile.base_url.trim() &&
        !editProfile.api_key.trim() &&
        !editProfile.model.trim() &&
        !editProfile.vision_model.trim());
    if (isBlank && editProfile) {
      updateProfile(editProfile.id, {
        name: p.id === 'custom' ? '' : p.name,
        base_url: p.base_url,
        model: p.models[0] || '',
      });
    } else {
      const np: ProfileUi = {
        id: 'p_' + Math.random().toString(36).slice(2, 8),
        name: p.id === 'custom' ? '' : p.name,
        base_url: p.base_url,
        api_key: '',
        model: p.models[0] || '',
        vision_model: '',
        temperature: 0.3,
        max_tokens: '',
        top_p: '',
        system_prompt: '',
        thinking: false,
        persona_call_me_as: '',
        persona_preset: '',
        persona_style: '',
      };
      setProfiles((prev) => [...prev, np]);
      setEditId(np.id);
    }
  }, [editProfile, updateProfile, setProfiles]);

  const addProfile = useCallback(() => {
    const np = defaultProfile('OpenAI');
    setProfiles((prev) => [...prev, np]);
    setEditId(np.id);
  }, []);

  const deleteProfile = useCallback((id: string) => {
    setProfiles((prev) => {
      const next = prev.filter((p) => p.id !== id);
      if (next.length === 0) {
        const d = defaultProfile();
        setActiveId(d.id);
        setEditId(d.id);
        return [d];
      }
      if (activeId === id) setActiveId(next[0].id);
      if (editId === id) setEditId(next[0].id);
      return next;
    });
  }, [activeId, editId]);

  const resetDefaults = useCallback(() => {
    if (!editProfile) return;
    const d = defaultProfile(editProfile.name || 'DeepSeek');
    updateProfile(editProfile.id, {
      base_url: d.base_url,
      api_key: '',
      model: d.model,
      temperature: d.temperature,
      max_tokens: '',
      top_p: '',
      system_prompt: '',
      thinking: false,
      persona_call_me_as: '',
      persona_preset: '',
      persona_style: '',
    });
    setTestMsg(null);
  }, [editProfile, updateProfile]);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
          <Cpu size={14} />
          {t('modelSettings.heading')}
        </h2>
        <p className="text-xs text-neutral-400 dark:text-stone-500 mb-3">
          {t('modelSettings.intro')}
        </p>

        <div className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden">
          {/* 已配置模型（预设列表：配置几个显示几个） */}
          <div className="p-4">
            <label className={labelCls}>{t('modelSettings.configured', { n: profiles.length })}</label>
            <div className="space-y-2">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setEditId(p.id)}
                  className={`group flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                    editId === p.id
                      ? 'element-muted border-[var(--element-border)]'
                      : 'bg-white dark:bg-stone-900 border-neutral-200/50 dark:border-stone-600/50 hover:bg-neutral-50 dark:hover:bg-stone-700'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate flex items-center gap-1.5">
                      {p.name || p.model || t('modelSettings.unnamed')}
                      {activeId === p.id && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500">
                          <Star size={11} className="fill-amber-500" />{t('modelSettings.default')}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                      {p.model || p.base_url || t('modelSettings.noEndpoint')}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {activeId !== p.id && (
                      <button
                        onClick={() => setActiveId(p.id)}
                        className="btn-press px-2 py-1 rounded-md text-[11px] bg-neutral-100 dark:bg-stone-700 text-neutral-600 dark:text-stone-300 hover:bg-neutral-200 dark:hover:bg-stone-600 transition-colors"
                        title={t('modelSettings.setDefault')}
                      >
                        {t('modelSettings.setDefault')}
                      </button>
                    )}
                    <button
                      onClick={() => deleteProfile(p.id)}
                      className="btn-press p-1.5 rounded-md text-neutral-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title={t('modelSettings.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {profiles.length === 0 && (
              <div className="text-xs text-neutral-400 dark:text-stone-500 py-1">{t('modelSettings.noModels')}</div>
            )}
            <button
              onClick={addProfile}
              className="btn-press mt-2 w-full py-2 rounded-lg border border-dashed border-neutral-300 dark:border-stone-600 text-xs text-neutral-500 dark:text-stone-400 hover:bg-neutral-50 dark:hover:bg-stone-700/50 transition-colors flex items-center justify-center gap-1.5"
            >
              <Plus size={14} />{t('modelSettings.addProfile')}
            </button>
          </div>

          {/* 当前编辑档案的详情（供应商预设 + 字段） */}
          {editProfile && (
            <>
              {/* 供应商预设 */}
              <div className="p-4">
                <label className={labelCls}>{t('modelSettings.providerPreset')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => selectProvider(p.id)}
                      className={`btn-press h-12 rounded-lg border text-sm font-medium transition-all ${
                        editProfile.name === p.name
                          ? 'element-muted border-[var(--element-border)]'
                          : 'bg-white dark:bg-stone-900 border-neutral-200/50 dark:border-stone-600/50 text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-stone-700'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                {/* DeepSeek API 充值入口（充一次约用一个月，但仅中低强度使用可维持一个月；推荐 deepseek-v4-flash） */}
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => openUrl('https://platform.deepseek.com/top_up').catch(() => {})}
                    className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium bg-[#4d6bfe]/10 text-[#4d6bfe] hover:bg-[#4d6bfe]/20 transition-colors flex items-center gap-1.5"
                    title={t('modelSettings.deepseekTopupTitle')}
                  >
                    <ExternalLink size={13} /> {t('modelSettings.deepseekTopup')}
                  </button>
                  <span className="text-[11px] text-neutral-400 dark:text-stone-500">
                    {t('modelSettings.deepseekHint')}
                  </span>
                </div>
              </div>

              {/* 显示名 */}
              <div className="p-4">
                <label className={labelCls}>{t('modelSettings.displayName')}</label>
                <input
                  className={inputCls}
                  value={editProfile.name}
                  placeholder="DeepSeek"
                  onChange={(e) => updateProfile(editProfile.id, { name: e.target.value })}
                />
              </div>

              {/* API 端点 */}
              <div className="p-4">
                <label className={labelCls}><Server size={12} className="inline mr-1" />{t('modelSettings.baseUrl')}</label>
                <input
                  className={inputCls}
                  value={editProfile.base_url}
                  placeholder="https://api.deepseek.com/v1"
                  onChange={(e) => updateProfile(editProfile.id, { base_url: e.target.value })}
                />
              </div>

              {/* API Key */}
              <div className="p-4">
                <label className={labelCls}><KeyRound size={12} className="inline mr-1" />{t('modelSettings.apiKey')}</label>
                <div className="relative">
                  <input
                    className={`${inputCls} pr-10`}
                    type={showKey ? 'text' : 'password'}
                    value={editProfile.api_key}
                    placeholder="sk-..."
                    autoComplete="off"
                    onChange={(e) => updateProfile(editProfile.id, { api_key: e.target.value })}
                  />
                  <button
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200 transition-colors"
                    title={showKey ? t('modelSettings.hide') : t('modelSettings.show')}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {/* 模型 + 温度 */}
              <div className="p-4 space-y-4">
                <div>
                  <label className={labelCls}><Bot size={12} className="inline mr-1" />{t('modelSettings.modelName')}</label>
                  <input
                    className={inputCls}
                    list="ai-model-suggestions"
                    value={editProfile.model}
                    placeholder="deepseek-chat"
                    onChange={(e) => updateProfile(editProfile.id, { model: e.target.value })}
                  />
                  <datalist id="ai-model-suggestions">
                    {ALL_MODELS.map((m) => <option key={m} value={m} />)}
                  </datalist>
                  <p className="text-[11px] text-neutral-400 dark:text-stone-500 mt-1">
                    {t('modelSettings.modelNameHint')}
                  </p>
                </div>
                <div>
                  <label className={labelCls}><Bot size={12} className="inline mr-1" />{t('modelSettings.visionModel')}</label>
                  <input
                    className={inputCls}
                    list="ai-vision-model-suggestions"
                    value={editProfile.vision_model}
                    placeholder={t('modelSettings.visionModelPlaceholder')}
                    onChange={(e) => updateProfile(editProfile.id, { vision_model: e.target.value })}
                  />
                  <datalist id="ai-vision-model-suggestions">
                    {ALL_VISION_MODELS.map((m) => <option key={m} value={m} />)}
                  </datalist>
                  <p className="text-[11px] text-neutral-400 dark:text-stone-500 mt-1">
                    {t('modelSettings.visionModelHint')}
                  </p>
                </div>
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label className={labelCls}>{t('modelSettings.temperature')}</label>
                    <span className="text-xs text-neutral-500 dark:text-stone-400">{editProfile.temperature.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={editProfile.temperature}
                    onChange={(e) => updateProfile(editProfile.id, { temperature: parseFloat(e.target.value) })}
                    className="w-full accent-[var(--element-color-raw)]"
                  />
                  <p className="text-[11px] text-neutral-400 dark:text-stone-500 mt-1">{t('modelSettings.temperatureHint')}</p>
                </div>
              </div>

              {/* 人设（Persona）：从高级参数移出，作为独立醒目区块 */}
              <section className="rounded-xl border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900/40 p-4 space-y-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-neutral-700 dark:text-stone-200">{t('modelSettings.persona')}</span>
                  <span className="text-[11px] text-neutral-400 dark:text-stone-500">{t('modelSettings.personaDesc')}</span>
                </div>

                {/* 称呼 */}
                <div>
                  <label className={labelCls}>{t('modelSettings.callMeAs')}</label>
                  <input
                    className={inputCls}
                    value={editProfile.persona_call_me_as}
                    placeholder={t('modelSettings.callMeAsPlaceholder')}
                    onChange={(e) => updateProfile(editProfile.id, { persona_call_me_as: e.target.value })}
                  />
                </div>

                {/* 风格预设 */}
                <div>
                  <label className={labelCls}>{t('modelSettings.personaStyle')}</label>
                  <div className="flex flex-wrap gap-2">
                    {PERSONA_PRESETS.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => updateProfile(editProfile.id, { persona_preset: p.key })}
                        className={`px-3 py-1.5 rounded-full text-[12px] border transition-colors ${
                          editProfile.persona_preset === p.key
                            ? 'border-[var(--element-border)] bg-[rgba(230,195,92,0.14)] text-neutral-800 dark:text-stone-100 font-medium'
                            : 'border-neutral-200 dark:border-stone-700 text-neutral-600 dark:text-stone-300 hover:border-neutral-300'
                        }`}
                      >
                        {t(p.labelKey)}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-neutral-400 dark:text-stone-500 mt-1.5">
                    {PERSONA_PRESETS.find((p) => p.key === editProfile.persona_preset)?.descKey ? t(PERSONA_PRESETS.find((p) => p.key === editProfile.persona_preset)!.descKey) : t('persona.noPreset')}
                  </p>
                </div>

                {/* 自定义风格 */}
                <div>
                  <label className={labelCls}>{t('modelSettings.customStyle')}</label>
                  <textarea
                    className={`${inputCls} resize-none`}
                    rows={2}
                    value={editProfile.persona_style}
                    placeholder={t('modelSettings.customStylePlaceholder')}
                    onChange={(e) => updateProfile(editProfile.id, { persona_style: e.target.value })}
                  />
                </div>

                {/* 额外要求（原 system prompt，拼接在人设之后） */}
                <div>
                  <label className={labelCls}>{t('modelSettings.extraPrompt')}</label>
                  <textarea
                    className={`${inputCls} resize-none`}
                    rows={3}
                    value={editProfile.system_prompt}
                    placeholder={t('modelSettings.extraPromptPlaceholder')}
                    onChange={(e) => updateProfile(editProfile.id, { system_prompt: e.target.value })}
                  />
                </div>
              </section>

              {/* 高级参数 */}
              <div>
                <div
                  onClick={() => setAdvancedOpen((o) => !o)}
                  className="w-full flex justify-between items-center p-4 cursor-pointer hover:bg-neutral-50 dark:hover:bg-stone-700/40 transition-colors"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setAdvancedOpen((o) => !o); }}
                >
                  <span className="text-sm font-medium text-neutral-700 dark:text-stone-200 flex items-center gap-1.5">
                    <SlidersHorizontal size={14} />{t('modelSettings.advanced')}
                  </span>
                  {advancedOpen ? <ChevronUp size={16} className="text-neutral-400 dark:text-stone-500" /> : <ChevronDown size={16} className="text-neutral-400 dark:text-stone-500" />}
                </div>
                {advancedOpen && (
                  <div className="px-4 pb-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>{t('modelSettings.maxTokens')}</label>
                        <input
                          className={inputCls}
                          type="number"
                          min={1}
                          value={editProfile.max_tokens}
                          placeholder={t('modelSettings.optionalDefault')}
                          onChange={(e) => updateProfile(editProfile.id, { max_tokens: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>{t('modelSettings.topP')}</label>
                        <input
                          className={inputCls}
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={editProfile.top_p}
                          placeholder={t('modelSettings.optionalDefault')}
                          onChange={(e) => updateProfile(editProfile.id, { top_p: e.target.value })}
                        />
                      </div>
                    </div>
                    {/* 思考模式开关（默认关；开启后模型先输出思维链再回答，支持 reasoning_content） */}
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 dark:bg-stone-800/50 border border-neutral-200 dark:border-stone-700 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-neutral-700 dark:text-stone-200">{t('modelSettings.thinking')}</div>
                        <div className="text-[11px] text-neutral-500 dark:text-stone-400 mt-0.5 leading-snug">
                          {t('modelSettings.thinkingDesc')}
                        </div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={editProfile.thinking === true}
                          onChange={(e) => updateProfile(editProfile.id, { thinking: e.target.checked })}
                        />
                        <div className="w-10 h-5 bg-neutral-300 dark:bg-stone-600 peer-focus:ring-2 peer-focus:ring-[var(--element-border)] rounded-full peer peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--element-border)]"></div>
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* 操作区：测试 / 保存 / 重置 */}
          <div className="p-4 flex flex-wrap items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testing}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-200 dark:hover:bg-stone-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <TestTube2 size={14} />{testing ? t('modelSettings.testing') : t('modelSettings.testConn')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-press px-4 py-1.5 rounded-lg text-xs font-medium element-primary hover:bg-[var(--element-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t('modelSettings.saving') : t('modelSettings.saveAll')}
            </button>
            <button
              onClick={() => {
                if (window.confirm(t('modelSettings.resetConfirm'))) {
                  resetDefaults();
                }
              }}
              className="btn-press px-3 py-1.5 rounded-lg text-xs bg-neutral-100 dark:bg-stone-700 text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors flex items-center gap-1.5"
              title={t('modelSettings.resetTitle')}
            >
              <RotateCcw size={14} />{t('modelSettings.reset')}
            </button>
            {savedAt && (
              <span className="text-xs text-emerald-500 flex items-center gap-1"><Check size={13} />{t('modelSettings.saved')}</span>
            )}
            {testMsg && (
              <span className={`text-xs flex items-center gap-1 ${testMsg.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                {testMsg.ok ? <Check size={13} /> : <X size={13} />}{testMsg.text}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export default ModelSettings;
