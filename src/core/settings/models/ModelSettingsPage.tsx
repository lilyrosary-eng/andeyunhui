import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/lib/i18n';
import { Plus, Radar, Cpu, Image as ImageIcon } from 'lucide-react';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { fromConfig, toConfig, type ConfigUi, type ModelUi, type ProviderUi } from '../aiConfigCodec';
import { ProviderCard } from './ProviderCard';
import { DiscoverModelsDialog, type AdoptedModel } from './DiscoverModelsDialog';
import { bestScore } from '@/lib/fuzzy';

const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

function blankModel(id?: string): ModelUi {
  return {
    id: id || newId('m'), model: '', label: '', caps: { text: true, vision: false, reasoning: false, embedding: false },
    context_tokens: '', temperature: '', max_tokens: '', top_p: '', system_prompt: '',
    thinking: false, persona_call_me_as: '', persona_preset: '', persona_style: '',
  };
}

function blankProvider(baseUrl = ''): ProviderUi {
  return {
    id: newId('pv'), name: '', base_url: baseUrl, api_key: '',
    vision_model: '', image_model: '', tts_model: '', last_scanned_at: null,
    models: [blankModel()],
  };
}

export function ModelSettingsPage() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<ConfigUi>({ providers: [], selected_provider_id: null, selected_model_id: null });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [discoverFor, setDiscoverFor] = useState<string | null>(null);
  // 打开发现弹窗时冻结一份目标：已有供应商用当前值，新建用空白。
  // 不能每次 render 现算——否则用户在弹窗里输入到一半的地址会被重置。
  const [discoverSeed, setDiscoverSeed] = useState<ProviderUi | null>(null);
  const [loaded, setLoaded] = useState(false);
  // ComfyUI 本地生图：配置 + 手动生成验证（与供应商云端 image_model 并列的另一条生图后端）
  const [comfyuiUrl, setComfyuiUrl] = useState('http://127.0.0.1:8188');
  const [comfyuiCkpt, setComfyuiCkpt] = useState('');
  const [cmfyPrompt, setCmfyPrompt] = useState('');
  const [cmfyBusy, setCmfyBusy] = useState(false);
  const [cmfyImg, setCmfyImg] = useState<string | null>(null);
  const [cmfyErr, setCmfyErr] = useState<string | null>(null);

  // 展开状态：记住用户上次展开哪些供应商，切换到别的设置 tab 再回来不用重新展
  useEffect(() => {
    try { setExpanded(JSON.parse(storage.getString(KEYS.ai.providerExpanded.key, '{}')) || {}); } catch { setExpanded({}); }
  }, []);

  // 启动读取：走 v2 命令。插件与移动端仍走旧的 ai_get_profiles（兼容层挡住了）
  useEffect(() => {
    invoke<any>('ai_get_config')
      .then((d) => { setCfg(fromConfig(d)); setLoaded(true); })
      .catch((e) => { console.warn('[模型] 读取配置失败:', e); setLoaded(true); });
  }, []);

  // ComfyUI 配置读取
  useEffect(() => {
    setComfyuiUrl(storage.getString(KEYS.ai.comfyuiUrl.key, 'http://127.0.0.1:8188'));
    setComfyuiCkpt(storage.getString(KEYS.ai.comfyuiCkpt.key, ''));
  }, []);

  // 自动持久化：800ms 防抖静默落盘，避免用户忘了点保存。首屏读取后不触发写入。
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    if (!loaded || cfg.providers.length === 0) return;
    const timer = setTimeout(() => {
      invoke('ai_set_config', { payload: toConfig(cfg) })
        .catch((e) => console.warn('[模型] 自动保存失败:', e));
    }, 800);
    return () => clearTimeout(timer);
  }, [cfg, loaded]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      storage.setString(KEYS.ai.providerExpanded.key, JSON.stringify(next));
      return next;
    });
  }, []);

  const patchProvider = useCallback((id: string, patch: Partial<ProviderUi>) => {
    setCfg((prev) => ({ ...prev, providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }, []);

  const patchModel = useCallback((providerId: string, modelId: string, patch: Partial<ModelUi>) => {
    setCfg((prev) => ({
      ...prev,
      providers: prev.providers.map((p) => p.id !== providerId
        ? p
        : { ...p, models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) }),
    }));
  }, []);

  const removeModel = useCallback((providerId: string, modelId: string) => {
    setCfg((prev) => {
      const providers = prev.providers.map((p) => p.id === providerId
        ? { ...p, models: p.models.filter((m) => m.id !== modelId) } : p);
      return {
        ...prev,
        providers,
        selected_model_id: prev.selected_model_id === modelId ? null : prev.selected_model_id,
      };
    });
  }, []);

  /** selection 是单选：同时更新供应商与模型，resolve_target 只认 model_id */
  const selectModel = useCallback((providerId: string, modelId: string) => {
    setCfg((prev) => ({ ...prev, selected_provider_id: providerId, selected_model_id: modelId }));
  }, []);

  const removeProvider = useCallback((providerId: string) => {
    const p = cfg.providers.find((x) => x.id === providerId);
    if (!p) return;
    const msg = t('modelSettings.removeProviderConfirm', { n: p.models.length, name: p.name || p.base_url });
    if (!window.confirm(msg)) return;
    setCfg((prev) => ({
      providers: prev.providers.filter((x) => x.id !== providerId),
      selected_provider_id: prev.selected_provider_id === providerId ? null : prev.selected_provider_id,
      selected_model_id: prev.selected_model_id && p.models.some((m) => m.id === prev.selected_model_id)
        ? null : prev.selected_model_id,
    }));
  }, [cfg.providers, t]);

  const addProvider = useCallback(() => {
    const p = blankProvider();
    setCfg((prev) => ({ ...prev, providers: [...prev.providers, p] }));
    setExpanded((prev) => {
      const next = { ...prev, [p.id]: true };
      storage.setString(KEYS.ai.providerExpanded.key, JSON.stringify(next));
      return next;
    });
  }, []);

  // 打开发现弹窗。providerId 为 undefined 时是「新建供应商」模式。
  const openDiscover = useCallback((providerId?: string) => {
    setDiscoverSeed(providerId ? cfg.providers.find((p) => p.id === providerId) ?? blankProvider() : blankProvider());
    setDiscoverFor(providerId ?? '__new__');
  }, [cfg.providers]);

  const closeDiscover = useCallback(() => {
    setDiscoverFor(null);
    setDiscoverSeed(null);
  }, []);

  // 搜索：命中模型名时自动展开对应卡片并高亮该行；命中供应商名/端点则整卡靠前
  const { visibleProviders, highlights } = useMemo(() => {
    const q = query.trim();
    if (!q) return { visibleProviders: cfg.providers, highlights: {} as Record<string, string> };
    const hi: Record<string, string> = {};
    const matched = cfg.providers.filter((p) => {
      const providerHit = scoreProvider(q, p) >= 0;
      let modelHit = false;
      for (const m of p.models) {
        if (scoreModel(q, m) >= 0) { hi[p.id] = m.id; modelHit = true; break; }
      }
      return providerHit || modelHit;
    });
    return { visibleProviders: matched, highlights: hi };
  }, [query, cfg.providers]);

  // 命中模型的卡片自动展开，否则用户搜到了却看不到
  useEffect(() => {
    if (!query.trim()) return;
    const ids = Object.keys(highlights);
    if (!ids.length) return;
    setExpanded((prev) => {
      if (ids.every((id) => prev[id])) return prev;
      const next = { ...prev };
      ids.forEach((id) => { next[id] = true; });
      return next;
    });
  }, [highlights, query]);

  const saveComfyuiUrl = (v: string) => { setComfyuiUrl(v); storage.setString(KEYS.ai.comfyuiUrl.key, v); };
  const saveComfyuiCkpt = (v: string) => { setComfyuiCkpt(v); storage.setString(KEYS.ai.comfyuiCkpt.key, v); };
  const comfyuiGenerate = async () => {
    if (cmfyBusy) return;
    const p = cmfyPrompt.trim();
    if (!p) { setCmfyErr(t('modelSettings.comfyui.needPrompt')); return; }
    setCmfyBusy(true); setCmfyErr(null); setCmfyImg(null);
    try {
      const dataUrl = await invoke<string>('comfyui_generate_image', { prompt: p, comfyuiUrl, checkpoint: comfyuiCkpt });
      setCmfyImg(dataUrl);
    } catch (e) { setCmfyErr(String(e)); }
    finally { setCmfyBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-1 flex items-center gap-1.5">
          <Cpu size={14} />{t('modelSettings.heading')}
        </h2>
        <p className="text-xs text-neutral-400 dark:text-stone-500">{t('modelSettings.intro')}</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="flex-1 px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
          value={query}
          placeholder={t('modelSettings.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => openDiscover()}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-neutral-200 dark:border-stone-700 hover:bg-neutral-100 dark:hover:bg-stone-800"
          title={t('modelSettings.scanByPort')}>
          <Radar size={14} />{t('modelSettings.scanByPort')}
        </button>
        <button onClick={addProvider}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-[var(--element-border)] text-white">
          <Plus size={14} />{t('modelSettings.addProvider')}
        </button>
      </div>

      {visibleProviders.length === 0 ? (
        <div className="py-12 text-center text-sm text-neutral-400">
          {query.trim() ? t('modelSettings.noMatch') : t('modelSettings.emptyState')}
        </div>
      ) : (
        visibleProviders.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            expanded={!!expanded[p.id]}
            onToggle={() => toggleExpand(p.id)}
            hasSelected={p.models.some((m) => m.id === cfg.selected_model_id)}
            selectedModelId={cfg.selected_model_id}
            onSelectModel={(mid) => selectModel(p.id, mid)}
            onPatchModel={(mid, patch) => patchModel(p.id, mid, patch)}
            onAddModel={() => patchProvider(p.id, { models: [...p.models, blankModel()] })}
            onRemoveModel={(mid) => removeModel(p.id, mid)}
            onOpenDiscover={() => openDiscover(p.id)}
            onPatchProvider={(patch) => patchProvider(p.id, patch)}
            onRemoveProvider={() => removeProvider(p.id)}
            highlightModelId={highlights[p.id] ?? null}
            t={t}
          />
        ))
      )}

      <DiscoverModelsDialog
        provider={discoverSeed}
        onClose={closeDiscover}
        onAdopt={(baseUrl: string, apiKey: string, models: AdoptedModel[]) => {
          if (discoverFor === '__new__') {
            const p = blankProvider(baseUrl);
            p.api_key = apiKey;
            p.models = models.map((m) => ({ ...blankModel(m.id), ...m }));
            setCfg((prev) => ({ ...prev, providers: [...prev.providers, p] }));
            setExpanded((prev) => {
              const next = { ...prev, [p.id]: true };
              storage.setString(KEYS.ai.providerExpanded.key, JSON.stringify(next));
              return next;
            });
          } else if (discoverSeed) {
            patchProvider(discoverSeed.id, {
              base_url: baseUrl,
              api_key: apiKey || discoverSeed.api_key,
              last_scanned_at: Math.floor(Date.now() / 1000),
            });
          }
          closeDiscover();
        }}
        t={t}
      />

      {/* 本地生图（ComfyUI）：配置端点 + checkpoint，可手动生成验证。
          与供应商的云端 image_model 并列的另一条生图后端；AI 工具自动触发为后续接入。 */}
      <div className="rounded-xl border border-neutral-200 dark:border-stone-700 bg-white/60 dark:bg-stone-900/40 p-4 space-y-3">
        <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 dark:text-stone-200">
          <ImageIcon size={14} />{t('modelSettings.comfyui.title')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium">{t('modelSettings.comfyui.endpoint')}</label>
            <input className="w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]" value={comfyuiUrl} placeholder="http://127.0.0.1:8188" onChange={(e) => saveComfyuiUrl(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium">{t('modelSettings.comfyui.checkpoint')}</label>
            <input className="w-full px-3 py-2 rounded-lg text-sm font-mono bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]" value={comfyuiCkpt} placeholder="sd_xl_base.safetensors" onChange={(e) => saveComfyuiCkpt(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input className="flex-1 px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]" value={cmfyPrompt} placeholder={t('modelSettings.comfyui.promptPlaceholder')} onChange={(e) => setCmfyPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !cmfyBusy) void comfyuiGenerate(); }} />
          <button onClick={() => void comfyuiGenerate()} disabled={cmfyBusy} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-[var(--element-border)] text-white disabled:opacity-50">
            {cmfyBusy ? t('modelSettings.comfyui.generating') : t('modelSettings.comfyui.generate')}
          </button>
        </div>
        {cmfyErr && <div className="text-[11px] text-red-500 whitespace-pre-wrap break-all">{cmfyErr}</div>}
        {cmfyImg && <img src={cmfyImg} alt={t('modelSettings.comfyui.resultAlt')} className="max-h-64 rounded-lg border border-neutral-200 dark:border-stone-700" />}
      </div>
    </div>
  );
}

// 打分在文件底部集中定义，便于 Task 之后调整权重
function scoreProvider(q: string, p: ProviderUi): number {
  return bestScore(q, [
    { text: p.name, weight: 1.0 },
    { text: p.base_url, weight: 0.6 },
  ]);
}
function scoreModel(q: string, m: ModelUi): number {
  return bestScore(q, [
    { text: m.label, weight: 1.0 },
    { text: m.model, weight: 0.8 },
  ]);
}
