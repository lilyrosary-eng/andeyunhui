// 嵌入模型设置（设置 → 模型 → 嵌入模型）。
//
// 为什么单独一块、不并进「媒体能力链」：嵌入不是媒体能力。image/vision/speech 那三条链的
// 语义是「默认走模型原生能力，这里选的是兜底」，而嵌入没有"对话模型原生就能嵌入"这回事 ——
// 留空的真实含义是**没人配置，RAG 完全不做**。套进那套语义会让人以为"不选也生效"。
// （2026-11-05 用户指出「这个不是媒体模型，要拿出来」；此前嵌入那一行其实代码全写了，
//  只是没进 ENABLED_KINDS，所以界面永远不渲染。）
//
// ★ 这一块是嵌入配置的**唯一入口**。此前同一份 localStorage
//   （`andeyunhui.mobile.rag.embed`）长在三个界面上：RAG 插件的嵌入端点卡片、
//   AI 对话的记忆面板、移动端设置 —— 而且优先级还和运行时不一致。
//   优先级统一为：**本页选定 > 手动端点（高级） > 自动猜测**。
import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { InlineSelect } from '@/components/ui/inline-select';
import { ChevronDown, Cpu, Loader2 } from 'lucide-react';
import {
  clearEmbedConfig,
  describeEffectiveEmbed,
  getEmbedConfig,
  setEmbedConfig,
  type EmbedConfig,
} from '@/core/stores/semanticMemory';
import type { AiProfile } from '@/mobile/types/chat';
import { inputCls } from '@/components/bricks/formui';
import type { ProviderUi } from '../aiConfigCodec';

type TFunc = (k: string, vars?: Record<string, string | number>) => string;

const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1';

/** 下拉里的一个候选模型。 */
interface Candidate {
  name: string;
  provider: string;
  /** 所属供应商端点：只用来把「当前算力来源」的模型排到前面，不参与生效判定 */
  baseUrl: string;
  /** 该模型被标了「向量」能力（供应商能力探测扫出来或用户手勾） */
  tagged: boolean;
}

export function EmbeddingPanel({
  t,
  value,
  providers,
  onChange,
}: {
  t: TFunc;
  /** `media_models.embedding`：本页选定的那个模型名 */
  value: string;
  providers: ProviderUi[];
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [explicit, setExplicit] = useState<EmbedConfig | null>(() => getEmbedConfig());
  const [draft, setDraft] = useState<EmbedConfig>(() => getEmbedConfig() ?? { endpoint: '', apiKey: '', model: '' });
  // 运行时用的同一份输入：ai_get_profiles（providers × models 一条一档）+ active
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [active, setActive] = useState<string | null>(null);

  // 只在展开时取一次
  useEffect(() => {
    if (!open) return;
    let alive = true;
    invoke<{ profiles?: AiProfile[]; active?: string | null }>('ai_get_profiles')
      .then((d) => {
        if (!alive) return;
        setProfiles(d?.profiles ?? []);
        setActive(d?.active ?? null);
      })
      .catch((e) => console.warn('[embedding] 读取算力档案失败（下拉仍可用，仅生效来源显示不出来）:', e));
    return () => {
      alive = false;
    };
  }, [open]);

  /**
   * 候选列表。优先列**已标「向量」能力**的模型（供应商能力探测扫出来的，见 ai_discover.rs），
   * 一个都没有时退回全部模型 —— 否则没扫过的用户会面对一个空下拉，比猜名字更糟。
   */
  const candidates = useMemo<Candidate[]>(() => {
    const all: Candidate[] = [];
    for (const p of providers) {
      for (const m of p.models ?? []) {
        const name = (m.model ?? '').trim();
        if (!name || !p.base_url) continue;
        all.push({ name, provider: p.name || p.id, baseUrl: p.base_url, tagged: !!m.caps?.embedding });
      }
    }
    const tagged = all.filter((c) => c.tagged);
    const list = tagged.length ? tagged : all;
    // ★ 当前算力来源的模型排最前。否则列表按供应商顺序排，模型多的远端供应商
    //   （实测 NVIDIA 有 7 个嵌入模型）会占据开头 —— 用户随手一点/键盘一按就选中远端，
    //   正文会被发去第三方。这和运行时 pickAutoEmbedTarget 的「先同供应商」是同一条教训。
    const curBase = profiles.find((p) => p.id === active)?.base_url;
    if (curBase) list.sort((a, b) => Number(b.baseUrl === curBase) - Number(a.baseUrl === curBase));
    // 已选中的那个必须在列表里 —— 否则用户之前选的模型没被标「向量」时，
    // 下拉会显示成空白，看起来像"设置丢了"，而配置其实还在。
    const v = value.trim();
    if (v && !list.some((c) => c.name === v)) {
      const owner = all.find((c) => c.name === v);
      list.unshift(owner ? { ...owner, tagged: false } : { name: v, provider: '?', baseUrl: '', tagged: false });
    }
    return list;
  }, [providers, value, profiles, active]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const list = byProvider.get(c.provider) ?? [];
      list.push(c);
      byProvider.set(c.provider, list);
    }
    return [...byProvider.entries()];
  }, [candidates]);

  /**
   * 当前真正会用的那一条。直接调用运行时同一个函数 `describeEffectiveEmbed`，
   * 界面不再自己排优先级 —— 否则就是"显示一套、跑一套"。
   */
  const effective = useMemo(
    () => describeEffectiveEmbed(profiles, active, value),
    [profiles, active, value],
  );

  /** 手动端点填了、但因为本页已选定而不生效 —— 这种情况必须说破，否则用户只会觉得"填了没用"。 */
  const shadowed = !!(explicit?.endpoint && value.trim() && effective?.src === 'routing');

  const test = async () => {
    if (!effective) return;
    setBusy(true);
    setResult(null);
    const t0 = Date.now();
    try {
      const res = await invoke<{ embeddings: number[][]; dim?: number }>('rag_embed_api', {
        texts: ['安得云荟嵌入连通性测试'],
        endpoint: effective.endpoint,
        apiKey: effective.apiKey || null,
        model: effective.model || null,
      });
      const dim = res?.embeddings?.[0]?.length ?? res?.dim ?? 0;
      setResult({
        ok: dim > 0,
        text: `${t('modelSettings.mediaModels.testOk')} · ${dim} 维 · ${Date.now() - t0}ms · ${effective.endpoint}`,
      });
    } catch (e) {
      // 原样显示，不分类改写：改写就是把"让用户猜"换个地方继续
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () => {
    const next = { endpoint: draft.endpoint.trim(), apiKey: draft.apiKey.trim(), model: draft.model.trim() };
    if (!next.endpoint) return;
    setEmbedConfig(next);
    setExplicit(next);
  };

  const clearDraft = () => {
    clearEmbedConfig();
    setExplicit(null);
    setDraft({ endpoint: '', apiKey: '', model: '' });
  };

  const srcLabel = effective
    ? t(`modelSettings.embedding.src.${effective.src}`)
    : t('modelSettings.embedding.src.none');

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-stone-700 px-3 py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 text-[12px] font-medium text-neutral-600 dark:text-stone-300 hover:text-[var(--element-bg)]"
      >
        <Cpu size={13} />
        {t('modelSettings.embedding.title')}
        {/* 生效状态直接写在标题行：不展开也能看出"现在到底有没有配" */}
        <span className={`ml-1 text-[10px] ${effective && effective.src !== 'auto' ? 'text-emerald-600 dark:text-emerald-400' : effective ? 'text-amber-600 dark:text-amber-400' : 'text-red-500'}`}>
          · {srcLabel}
          {effective?.model ? ` · ${effective.model}` : ''}
        </span>
        <ChevronDown size={13} className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 space-y-2.5">
          <p className="text-[11px] text-neutral-500 dark:text-stone-400">{t('modelSettings.embedding.hint')}</p>

          <div>
            <label className={labelCls}>{t('modelSettings.embedding.pick')}</label>
            {/* 模型多时原生 optgroup 的标题不会跟着滚（弹出层由系统画），
                换成全站统一的 InlineSelect：厂商标题粘在顶部，看完这家才换下一家，
                还自带搜索。value 语义不变（存的是模型名，不是档案 id）。 */}
            <InlineSelect
              value={value}
              onChange={onChange}
              placeholder={t('modelSettings.embedding.unset')}
              title={t('modelSettings.embedding.pick')}
              className="w-full max-w-none justify-between"
              groups={[
                { label: '', options: [{ value: '', label: t('modelSettings.embedding.unset') }] },
                ...groups.map(([provider, list]) => ({
                  label: provider,
                  options: list.map((c) => ({ value: c.name, label: c.name })),
                })),
              ]}
            />
            {!candidates.some((c) => c.tagged) && (
              <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">{t('modelSettings.embedding.noCaps')}</p>
            )}
            {effective?.src === 'auto' && (
              <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">{t('modelSettings.embedding.autoWarn')}</p>
            )}
          </div>

          <div className="rounded-lg bg-neutral-50 dark:bg-stone-800/50 px-2.5 py-2 text-[11px] text-neutral-600 dark:text-stone-300">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-neutral-400 dark:text-stone-500">{t('modelSettings.embedding.effective')}：</span>
              {srcLabel}
              {effective?.note ? `（${effective.note}）` : ''}
            </div>
            <div className="mt-0.5 break-all font-mono text-[10px] text-neutral-500 dark:text-stone-400">
              {effective ? `${effective.endpoint}${effective.model ? ` · ${effective.model}` : ''}` : '—'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void test()}
              disabled={busy || !effective}
              className="btn-press rounded-lg border border-black/10 px-2.5 py-1 text-[11px] text-neutral-600 disabled:opacity-40 dark:border-white/10 dark:text-stone-300"
            >
              {busy ? <Loader2 size={11} className="animate-spin inline" /> : null}
              {busy ? t('modelSettings.mediaModels.testing') : t('modelSettings.mediaModels.test')}
            </button>
            <span className="text-[10px] text-neutral-400 dark:text-stone-500">{t('modelSettings.mediaModels.testHint')}</span>
          </div>
          {result && (
            <pre
              className={`text-[10px] whitespace-pre-wrap break-all m-0 ${
                result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
              }`}
            >
              {result.text}
            </pre>
          )}

          {/* 手动端点：只给"嵌入服务不在任何供应商档案里"的人（自建服务）。
              它排在手动位、低于本页选定，所以填了不一定生效 —— 那种情况下面明说。 */}
          <div className="rounded-lg border border-dashed border-neutral-200 dark:border-stone-700 px-2.5 py-2 space-y-1.5">
            <div className="text-[11px] text-neutral-500 dark:text-stone-400">{t('modelSettings.embedding.advanced')}</div>
            {shadowed && (
              <div className="text-[10px] text-red-500 dark:text-red-400">{t('modelSettings.embedding.shadowed')}</div>
            )}
            <input
              className={inputCls}
              placeholder={t('modelSettings.baseUrl')}
              value={draft.endpoint}
              onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
            />
            <div className="flex gap-1.5">
              <input
                className={`${inputCls} flex-1`}
                placeholder={t('modelSettings.apiKeyLabel')}
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
              <input
                className={`${inputCls} flex-1`}
                placeholder={t('modelSettings.modelName')}
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={saveDraft}
                disabled={!draft.endpoint.trim()}
                className="btn-press rounded-lg bg-[var(--element-bg)] px-2.5 py-1 text-[11px] text-white disabled:opacity-40"
              >
                {t('modelSettings.embedding.saveExplicit')}
              </button>
              {explicit?.endpoint && (
                <button
                  type="button"
                  onClick={clearDraft}
                  className="btn-press rounded-lg border border-black/10 px-2.5 py-1 text-[11px] text-neutral-600 dark:border-white/10 dark:text-stone-300"
                >
                  {t('modelSettings.embedding.clearExplicit')}
                </button>
              )}
              {explicit?.endpoint && (
                <span className="text-[10px] text-neutral-400 dark:text-stone-500">
                  {t('modelSettings.embedding.saved')}：{explicit.endpoint}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
