import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/lib/i18n';
import { Plus, Radar, Cpu } from 'lucide-react';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { emptyMediaModels, emptyReasoning, fromConfig, toConfig, type ConfigUi, type ModelUi, type ProviderUi } from '../aiConfigCodec';
import { ProviderCard } from './ProviderCard';
import { DiscoverModelsDialog, type AdoptedModel } from './DiscoverModelsDialog';
import { ComfyuiPanel } from './ComfyuiPanel';
import { MediaBackendsPanel } from './MediaBackendsPanel';
import { inferProviderName, mergeModels, newModelKey, refillCapacity, refillCaps, sameBaseUrl } from './providerMatch';
import { bestScore } from '@/lib/fuzzy';

const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

function blankModel(id?: string): ModelUi {
  return {
    id: id || newId('m'), model: '', label: '',
    caps: { text: true, vision: false, reasoning: false, embedding: false, tools: false, vision_source: '' },
    context_tokens: '', max_output_tokens: '', context_source: '', max_output_source: '',
    temperature: '', max_tokens: '', top_p: '', system_prompt: '',
    thinking: false, reasoning_effort: '', reasoning: emptyReasoning(),
    persona_call_me_as: '', persona_preset: '', persona_style: '',
  };
}

function blankProvider(baseUrl = ''): ProviderUi {
  return {
    id: newId('pv'), name: '', base_url: baseUrl, api_key: '',
    vision_model: '', image_model: '', tts_model: '', last_scanned_at: null,
    models: [blankModel()],
  };
}

/** 浮窗提示的显示时长（毫秒）。 */
const TOAST_MS = 3600;

export function ModelSettingsPage() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<ConfigUi>({ providers: [], selected_provider_id: null, selected_model_id: null, media_models: emptyMediaModels() });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  // 打开发现弹窗时冻结一份目标：已有供应商用当前值，新建用空白。
  // 不能每次 render 现算——否则用户在弹窗里输入到一半的地址会被重置。
  // 它同时充当弹窗的挂载开关（null = 不挂载），见下方条件渲染。
  const [discoverSeed, setDiscoverSeed] = useState<ProviderUi | null>(null);
  const [loaded, setLoaded] = useState(false);
  /**
   * 「本批新增」的模型 id —— 模型行底色橙色高亮。**非持久**：
   * 下一批新增会整体替换，展开/折叠、搜索时清空（用户诉求：非持久高亮）。
   */
  const [newModelIds, setNewModelIds] = useState<Set<string>>(new Set());
  /** 浮窗提示（复用预设 / 并入重复地址时给出显性反馈，数秒后自动消失）。 */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  // 能力探测开关。存在后端的小 JSON（`<data_root>/ai_caps_probe.json`），
  // 因为**后端**才是执行探测的一方，它必须能独立判断有没有被授权发这次请求
  // （只信前端传来的 flag 等于没开关）。
  const [probeEnabled, setProbeEnabled] = useState(false);
  useEffect(() => {
    invoke<boolean>('ai_get_caps_probe_enabled').then(setProbeEnabled).catch(() => {});
  }, []);
  /** 改「某能力用哪个模型」。写进配置档案（不是本地库），所以插件与移动端也读得到。 */
  const setMediaModel = useCallback((kind: 'image' | 'vision' | 'speech', value: string) => {
    setCfg((prev) => ({ ...prev, media_models: { ...prev.media_models, [kind]: value } }));
  }, []);

  const toggleProbe = useCallback(async () => {
    const next = !probeEnabled;
    try {
      await invoke('ai_set_caps_probe_enabled', { enabled: next });
      setProbeEnabled(next);
    } catch (e) {
      showToast(String(e));
    }
  }, [probeEnabled, showToast]);

  // 展开状态：记住用户上次展开哪些供应商，切换到别的设置 tab 再回来不用重新展
  useEffect(() => {
    try { setExpanded(JSON.parse(storage.getString(KEYS.ai.providerExpanded.key, '{}')) || {}); } catch { setExpanded({}); }
  }, []);

  // 启动读取：走 v2 命令。插件与移动端仍走旧的 ai_get_profiles（兼容层挡住了）
  useEffect(() => {
    invoke<any>('ai_get_config')
      .then((d) => {
        const next = fromConfig(d);
        setCfg(next);
        setLoaded(true);
        // 「正在使用」的供应商自动展开（诉求 #7）。放在加载回调里而不是单独 effect：
        // 这里正是「外部系统（配置）到位」的时刻，且不会触发 effect-内 setState 的级联渲染。
        setExpanded((prev) => {
          const sel = next.selected_provider_id;
          if (!sel || prev[sel]) return prev;
          const merged = { ...prev, [sel]: true };
          storage.setString(KEYS.ai.providerExpanded.key, JSON.stringify(merged));
          return merged;
        });
      })
      .catch((e) => { console.warn('[模型] 读取配置失败:', e); setLoaded(true); });
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

  /** 滚动到某个供应商卡片（复用/合并后把用户带过去，否则他不知道东西去哪了）。 */
  const scrollToProvider = useCallback((id: string) => {
    requestAnimationFrame(() => {
      document.getElementById(`provider-card-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);

  /** 展开并滚动到某供应商。 */
  const revealProvider = useCallback((id: string) => {
    setExpanded((prev) => {
      if (prev[id]) return prev;
      const next = { ...prev, [id]: true };
      storage.setString(KEYS.ai.providerExpanded.key, JSON.stringify(next));
      return next;
    });
    scrollToProvider(id);
  }, [scrollToProvider]);

  const toggleExpand = useCallback((id: string) => {
    // 展开/折叠属于「更高类操作」：清掉本批新增高亮
    setNewModelIds(new Set());
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
      ...prev,
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
  }, [cfg.providers]);

  const closeDiscover = useCallback(() => setDiscoverSeed(null), []);

  /**
   * 把采纳结果补成完整的 ModelUi 行（补齐 blankModel 的默认值）。
   * 逐字段显式搬运，避免把 AdoptedModel 的专属键（ctx_source/out_source）漏进 ModelUi。
   */
  const toModelRows = useCallback(
    (incoming: AdoptedModel[]): ModelUi[] =>
      incoming.map((m) => ({
        ...blankModel(m.id),
        model: m.model,
        label: m.label,
        caps: m.caps,
        context_tokens: m.context_tokens,
        max_output_tokens: m.max_output_tokens,
        context_source: m.ctx_source ?? '',
        max_output_source: m.out_source ?? '',
        reasoning: m.reasoning ?? emptyReasoning(),
      })),
    [],
  );

  /**
   * 采纳发现结果（诉求 #3）：
   * base_url 与已有预设**一模一样**时**不再新建**，而是复用该预设做增量合并；
   * 无论用户从「新建」还是从「重扫」进来，口径一致。
   */
  const handleAdopt = useCallback((baseUrl: string, apiKey: string, models: AdoptedModel[]) => {
    const target = cfg.providers.find((p) => sameBaseUrl(p.base_url, baseUrl));
    const now = Math.floor(Date.now() / 1000);

    if (target) {
      const rows = toModelRows(models);
      const { models: merged, added } = mergeModels(target.models, rows);
      // ★ 光「只增不减」不够：同名老条目的容量列会被永久挡在门外（重扫永远填不上）。
      //   这里按**逐字段来源**回填——空值和 provider/table 来源可刷新，手填的冻结。
      const withCapacity = refillCapacity(merged, rows);
      // 能力位同理（回填口径与容量**故意不同**，见 refillCaps 的说明）：
      // 不带这一步，改造前落盘的老条目永远拿不到新推断 —— 实测用户的 GLM-4V-Flash
      // 名字里明确带 4V 却一直是 vision=false，重扫多少遍都改不过来。
      const finalModels = refillCaps(withCapacity, rows);
      patchProvider(target.id, {
        models: finalModels,
        // 空 key 不覆盖已有 key（重扫时用户常常不重填 key）
        ...(apiKey ? { api_key: apiKey } : {}),
        last_scanned_at: now,
      });
      setNewModelIds(new Set(added.map((m) => newModelKey(target.id, m.id))));
      showToast(added.length > 0
        ? t('modelSettings.reuseToast', { name: target.name || target.base_url, n: added.length })
        : t('modelSettings.reuseToastNoNew', { name: target.name || target.base_url }));
      revealProvider(target.id);
    } else {
      const p = blankProvider(baseUrl);
      p.api_key = apiKey;
      // 自动获取拿不到供应商名 → 按域名推断（诉求 #4）；推断不出就留空由用户填
      p.name = inferProviderName(baseUrl);
      p.models = toModelRows(models);
      setCfg((prev) => ({ ...prev, providers: [...prev.providers, p] }));
      setNewModelIds(new Set(p.models.map((m) => newModelKey(p.id, m.id))));
      revealProvider(p.id);
    }
    closeDiscover();
  }, [cfg.providers, toModelRows, patchProvider, revealProvider, showToast, closeDiscover, t]);

  /**
   * 手动设置路径的同一套去重逻辑（诉求 #8）：
   * 把某个预设的地址改到与另一个**一模一样**时，把它的模型并入对方并去掉这个空壳，
   * 同时给出显性浮窗 + 跳转展开。挂在地址输入的「失焦/回车」上，不在每次按键时触发。
   */
  const commitBaseUrl = useCallback((providerId: string) => {
    const src = cfg.providers.find((p) => p.id === providerId);
    if (!src) return;
    // 名称为空时按域名补一个——手填地址也享受自动命名
    if (!src.name.trim() && src.base_url.trim()) {
      const guessed = inferProviderName(src.base_url);
      if (guessed) patchProvider(providerId, { name: guessed });
    }
    const target = cfg.providers.find((p) => p.id !== providerId && sameBaseUrl(p.base_url, src.base_url));
    if (!target) return;
    // 只搬「填过模型名」的行，避免把空行灌进对方预设
    const existing = new Set(target.models.map((m) => m.model));
    const incoming = src.models.filter((m) => m.model.trim() && !existing.has(m.model));
    setCfg((prev) => ({
      ...prev,
      providers: prev.providers
        .filter((p) => p.id !== providerId)
        .map((p) => (p.id === target.id
          ? {
              ...p,
              models: [...p.models, ...incoming],
              // 供应商级配置一并保留：target 已有值一律不动，空缺的用 src 补。
              // （早先只搬 models/api_key，源预设的名称与多模态三件套被**静默丢弃**。）
              api_key: p.api_key || src.api_key,
              name: p.name || src.name,
              vision_model: p.vision_model || src.vision_model,
              image_model: p.image_model || src.image_model,
              tts_model: p.tts_model || src.tts_model,
              last_scanned_at: p.last_scanned_at ?? src.last_scanned_at,
            }
          : p)),
      selected_provider_id: prev.selected_provider_id === providerId ? target.id : prev.selected_provider_id,
    }));
    if (incoming.length) setNewModelIds(new Set(incoming.map((m) => newModelKey(target.id, m.id))));
    showToast(t('modelSettings.mergeToast', { name: target.name || target.base_url }));
    revealProvider(target.id);
  }, [cfg.providers, patchProvider, showToast, revealProvider, t]);

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
          onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim()) setNewModelIds(new Set()); }}
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
          <div key={p.id} id={`provider-card-${p.id}`}>
            <ProviderCard
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
              onCommitBaseUrl={() => commitBaseUrl(p.id)}
              onRemoveProvider={() => removeProvider(p.id)}
              highlightModelId={highlights[p.id] ?? null}
              probeEnabled={probeEnabled}
              newModelIds={newModelIds}
              t={t}
            />
          </div>
        ))
      )}

      {/* ★ 条件挂载：关闭时整体卸载，使「关窗重开」= 全新实例 = 下拉与输入恢复初值。
          这条恢复路径是用户明确要求的，别改成常驻挂载。 */}
      {discoverSeed && (
        <DiscoverModelsDialog
          provider={discoverSeed}
          knownProviders={cfg.providers}
          onClose={closeDiscover}
          onAdopt={handleAdopt}
          t={t}
        />
      )}

      {/* 显性浮窗：复用已有预设 / 并入重复地址时告知结果，数秒后自动消失 */}
      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-xl bg-neutral-800 dark:bg-stone-700 text-white text-xs shadow-xl max-w-[80vw] text-center">
          {toast}
        </div>
      )}

      {/* 本地生图（ComfyUI）：端点/checkpoint 快速通道 + 工作流库（扫目录→转换→参数化生成）
          + 蓝图生图节点挂钩。与供应商云端 image_model 并列的另一条生图后端。 */}
      <ComfyuiPanel t={t} />

      {/* 媒体后端：**媒体能力的唯一配置处**。
          - 「清单 + 路由」决定走哪个端点、按什么顺序降级；
          - 每条能力链标题右侧的下拉框决定该能力**用哪个模型**（存在配置档案里，跨端可读）。
          刻意不再另设一套「媒体模型」面板：那会变成两个入口配同一件事 ——
          用户已经指出过这一点，是对的。 */}
      <MediaBackendsPanel
        t={t}
        mediaModels={cfg.media_models}
        providers={cfg.providers}
        onChangeMediaModel={setMediaModel}
      />

      {/* 能力探测：确证某个模型到底支不支持视觉。
          与「对话模型原生看图」直接相关——只有被确证（来源 provider）的模型
          才会走直发分支，其余一律维持「经 analyze_image 工具」的老路径。
          默认关闭：探测会真发一次可能计费的请求，入口不该在用户同意前就摆出来。 */}
      <div className="mt-6 rounded-xl border border-neutral-200 dark:border-stone-700 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">
              {t('modelSettings.capsProbe.enable')}
            </div>
            <p className="text-[11px] text-neutral-500 dark:text-stone-400 mt-1 leading-relaxed">
              {t('modelSettings.capsProbe.enableHint')}
            </p>
          </div>
          <button
            onClick={() => void toggleProbe()}
            className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${
              probeEnabled ? 'bg-[var(--element-border)]' : 'bg-neutral-300 dark:bg-stone-600'
            }`}
            role="switch"
            aria-checked={probeEnabled}
            title={t('modelSettings.capsProbe.enable')}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
                probeEnabled ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>
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
