import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Radar, Loader2, ChevronDown } from 'lucide-react';
import type { CapsUi, CapacitySourceUi, ProviderUi, ReasoningSpecUi } from '../aiConfigCodec';
import { capTags } from './capsTags';

// 后端返回的模型结构。注意：Rust 的 DiscoveredModel 没有 `id` 字段——模型名即天然 id，
// 所以前端用 model 作为 AdoptedModel 的 id（见 adopt()），不要读不存在的 m.id。
interface DiscoveredModel {
  model: string;
  label: string | null;
  caps: CapsUi;
  context_tokens: number | null;
  max_tokens: number | null;
  /** 容量来源（provider / table / null=都没识别出）。落盘后决定重扫能否覆盖。 */
  ctx_source: CapacitySourceUi | null;
  out_source: CapacitySourceUi | null;
  /** 推理档位（供应商上报优先，否则内置兜底）。 */
  reasoning: ReasoningSpecUi | null;
}

/**
 * 端点诊断（与 Rust `EndpointDiagnostics` 字段一一对齐，serde 用 camelCase）。
 *
 * 存在的理由：容量识别不行的原因分两种，**修法完全不同**：
 *   ① 端点压根不报 → 只能靠兜底表 / 手填；
 *   ② 端点报了、字段名是另一种方言 → 改几行代码就能修。
 * 没有这份数据之前，这两者只能靠猜（实测 184 个模型只有 9 个拿到端点值，
 * 但"是不是端点真没报"一直无从判断）。
 */
export interface EndpointDiagnostics {
  reachedUrl: string;
  topKeys: string[];
  modelKeys: string[];
  /** 端点报了、但我们没读的键 —— 这份清单就是下一步该支持的新方言。 */
  unrecognizedKeys: string[];
  /** 「端点**自报**」容量的模型数（不是最终值非空的数量 —— 后者含兜底表补的）。 */
  ctxReported: number;
  outReported: number;
  total: number;
}

export interface AdoptedModel {
  id: string;
  model: string;
  label: string;
  caps: CapsUi;
  context_tokens: string;
  /** 模型的单次最大输出（能力上限），与请求参数 max_tokens 不同。 */
  max_output_tokens: string;
  /** 上面两个值的来源，落盘供重扫时判断能否覆盖。 */
  ctx_source: CapacitySourceUi | null;
  out_source: CapacitySourceUi | null;
  reasoning: ReasoningSpecUi | null;
}

export interface DiscoverModelsDialogProps {
  /** 打开弹窗时的初始值：已有供应商传其当前快照，新建传一份空白。关闭时传 null。 */
  provider: ProviderUi | null;
  /** 已保存的供应商清单——供 endpoint 下拉复用（选它即回填该供应商的 url 与 key）。 */
  knownProviders?: ProviderUi[];
  onClose: () => void;
  onAdopt: (baseUrl: string, apiKey: string, models: AdoptedModel[]) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';
const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

function fmtLen(n: number | null): string {
  if (!n || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function DiscoverModelsDialog(props: DiscoverModelsDialogProps) {
  const { provider, knownProviders = [], t } = props;
  const [endpoint, setEndpoint] = useState(provider?.base_url ?? '');
  const [apiKey, setApiKey] = useState(provider?.api_key ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DiscoveredModel[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [diag, setDiag] = useState<EndpointDiagnostics | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);

  // 点弹窗外部收起 endpoint 下拉
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // ★ 调用方（ModelSettingsPage）在 discoverSeed 为空时**不挂载**本组件。
  //   因此「关窗再开」= 全新实例 = 所有 state 回到初值。这是**有意依赖**的行为：
  //   万一下拉被误操作弄没了、或想放弃手填，关窗重开即可恢复。
  //   若将来改成常驻挂载，必须显式加 key 或重置 state，否则此恢复路径会失效。
  if (!provider) return null;

  /** 从下拉里选供应商：回填 url 与 key。哨兵项「新供应商」传空串 → 清空两框。 */
  const pickOption = (url: string, key: string) => {
    setEndpoint(url);
    setApiKey(key);
    setCandidates(null); // 换端点后旧候选作废，避免误采纳别的端点的模型
    setDiag(null);
    setPicked(new Set());
    setError(null);
    setMenuOpen(false);
  };

  const run = async () => {
    if (!endpoint.trim()) { setError(t('modelSettings.discoverNoBaseUrl')); return; }
    setBusy(true); setError(null);
    try {
      const out = await invoke<{ resolvedBaseUrl: string; models: DiscoveredModel[]; diagnostics?: EndpointDiagnostics }>('ai_fetch_models', {
        input: { endpoint: endpoint.trim(), apiKey: apiKey.trim() || null },
      });
      if (out.models.length === 0) { setError(t('modelSettings.discoverEmpty')); return; }
      setEndpoint(out.resolvedBaseUrl);
      setCandidates(out.models);
      setDiag(out.diagnostics ?? null);
      // 已配置过的默认不勾选，避免覆盖用户手调过的容量与能力
      const known = new Set(provider?.models.map((m) => m.model) ?? []);
      setPicked(new Set(out.models.filter((m) => !known.has(m.model)).map((m) => m.model)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const adopt = () => {
    if (!candidates) return;
    const chosen = candidates.filter((m) => picked.has(m.model)).map((m) => ({
      // 后端 DiscoveredModel 无 id 字段，模型名即唯一 id
      id: m.model,
      model: m.model,
      label: m.label ?? '',
      caps: m.caps,
      context_tokens: m.context_tokens ? String(m.context_tokens) : '',
      max_output_tokens: m.max_tokens ? String(m.max_tokens) : '',
      ctx_source: m.ctx_source,
      out_source: m.out_source,
      reasoning: m.reasoning,
    }));
    props.onAdopt(endpoint.trim(), apiKey.trim(), chosen);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={props.onClose}>
      <div className="w-full max-w-xl rounded-xl bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 p-5"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100">{t('modelSettings.discoverTitle')}</h3>
            <p className="text-[11px] text-neutral-400 mt-0.5">{t('modelSettings.discoverDesc')}</p>
          </div>
          <button onClick={props.onClose} className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-stone-800">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelCls}>{t('modelSettings.endpointOrPort')}</label>
            <div className="flex gap-2">
              <div className="relative flex-1" ref={menuRef}>
                <input className={`${inputCls} pr-9`} value={endpoint} disabled={busy}
                  placeholder={t('modelSettings.endpointPlaceholder')}
                  onChange={(e) => setEndpoint(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void run(); }} />
                {/* 下拉：复用已保存的供应商（选它即回填 url + key）。首项是哨兵「新供应商」 */}
                <button
                  type="button"
                  onClick={() => setMenuOpen((o) => !o)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200"
                  title={t('modelSettings.discoverPickKnown')}
                  aria-label={t('modelSettings.discoverPickKnown')}
                >
                  <ChevronDown size={16} />
                </button>
                {menuOpen && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-10 max-h-56 overflow-y-auto rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-lg">
                    <button type="button" onClick={() => pickOption('', '')}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-50 dark:hover:bg-stone-800 border-b border-neutral-100 dark:border-stone-800 text-neutral-700 dark:text-stone-200">
                      {t('modelSettings.discoverNewProvider')}
                    </button>
                    {knownProviders.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-neutral-400">{t('modelSettings.discoverNoKnown')}</div>
                    ) : knownProviders.map((p) => (
                      <button key={p.id} type="button" onClick={() => pickOption(p.base_url, p.api_key)}
                        className="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-stone-800 border-b border-neutral-100 dark:border-stone-800 last:border-0">
                        <div className="text-xs text-neutral-700 dark:text-stone-200 truncate">{p.name || p.base_url}</div>
                        <div className="text-[10px] text-neutral-400 truncate">{p.base_url}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={run} disabled={busy || !endpoint.trim()}
                className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-neutral-200 dark:border-stone-700 hover:bg-neutral-100 dark:hover:bg-stone-800 disabled:opacity-40">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />}
                {busy ? t('modelSettings.discovering') : t('modelSettings.discover')}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-neutral-400">{t('modelSettings.scanByPortHint')}</p>
          </div>
          <div>
            <label className={labelCls}>{t('modelSettings.apiKeyForFetch')}</label>
            <input className={inputCls} type="password" value={apiKey} disabled={busy}
              placeholder={t('modelSettings.apiKeyOptional')}
              onChange={(e) => setApiKey(e.target.value)} />
          </div>

          {error && (
            <div className="text-[11px] text-red-500 whitespace-pre-wrap break-all">{error}</div>
          )}

          {/* 端点诊断：把「端点报了什么」与「我们读了什么」摊开对照。
              最有价值的是标题右侧那三个数 —— 端点自报 0/81 就说明"不是我们没读对，
              是端点压根不报"，那就只剩兜底表与手填两条路；反之就该去补字段方言。 */}
          {diag && (
            <div className="rounded-lg border border-neutral-200 dark:border-stone-700 text-[11px] overflow-hidden">
              <button
                onClick={() => setDiagOpen((v) => !v)}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-stone-800/50"
              >
                <ChevronDown size={12} className={diagOpen ? '' : '-rotate-90'} />
                <span className="text-neutral-600 dark:text-stone-300">
                  {t('modelSettings.diag.title')}
                </span>
                <span className="ml-auto text-neutral-400 tabular-nums">
                  {t('modelSettings.diag.reported', { ctx: diag.ctxReported, out: diag.outReported, n: diag.total })}
                </span>
              </button>
              {diagOpen && (
                <div className="px-2.5 pb-2 pt-2 space-y-1.5 border-t border-neutral-100 dark:border-stone-800">
                  <div className="text-neutral-400 break-all font-mono">{diag.reachedUrl}</div>
                  {diag.unrecognizedKeys.length > 0 ? (
                    <div>
                      <span className="text-amber-600 dark:text-amber-400">{t('modelSettings.diag.unrecognized')}</span>
                      <span className="font-mono text-neutral-600 dark:text-stone-300">
                        {diag.unrecognizedKeys.join(', ')}
                      </span>
                    </div>
                  ) : (
                    <div className="text-emerald-600 dark:text-emerald-400">{t('modelSettings.diag.allRecognized')}</div>
                  )}
                  <div className="text-neutral-400">
                    {t('modelSettings.diag.allKeys')}
                    <span className="font-mono break-all">{diag.modelKeys.join(', ') || '—'}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {candidates && (
            <div className="border border-neutral-200 dark:border-stone-700 rounded-lg max-h-[280px] overflow-y-auto">
              {candidates.map((m) => (
                <label key={m.model}
                  className="flex items-center gap-2 px-2.5 py-1.5 border-b border-neutral-100 dark:border-stone-800 last:border-0 hover:bg-neutral-50 dark:hover:bg-stone-800/50 cursor-pointer">
                  <input type="checkbox" checked={picked.has(m.model)}
                    onChange={(e) => setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.model); else next.delete(m.model);
                      return next;
                    })} />
                  <span className="flex-1 truncate font-mono text-xs">{m.model}</span>
                  <span className="shrink-0 text-[10px] text-neutral-400 tabular-nums"
                    title={t('modelSettings.lenHint')}>
                    {t('modelSettings.lenIn')} {fmtLen(m.context_tokens) || '—'}
                    {' · '}
                    {t('modelSettings.lenOut')} {fmtLen(m.max_tokens) || '—'}
                  </span>
                  <span className="shrink-0 flex gap-1">
                    {capTags(m.caps, t).map((tag) => (
                      <span key={tag} className="text-[10px] px-1 py-0.5 rounded bg-neutral-100 dark:bg-stone-800 text-neutral-500 dark:text-stone-400">
                        {tag}
                      </span>
                    ))}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-between items-center">
          {/* 发现失败不是死路：手填入口必须一直在 */}
          <button onClick={props.onClose} className="text-[11px] text-neutral-400 hover:text-neutral-600">
            {t('modelSettings.addManually')}
          </button>
          <div className="flex gap-2">
            <button onClick={props.onClose}
              className="px-3 py-1.5 rounded-lg text-sm border border-neutral-200 dark:border-stone-700">
              {t('modelSettings.cancel')}
            </button>
            <button onClick={adopt} disabled={!candidates || picked.size === 0}
              className="px-3 py-1.5 rounded-lg text-sm bg-[var(--element-border)] text-white disabled:opacity-40">
              {t('modelSettings.discoverAdopt', { n: picked.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
