import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Radar, Loader2 } from 'lucide-react';
import type { CapsUi, ProviderUi } from '../aiConfigCodec';

// 后端返回的模型结构。注意：Rust 的 DiscoveredModel 没有 `id` 字段——模型名即天然 id，
// 所以前端用 model 作为 AdoptedModel 的 id（见 adopt()），不要读不存在的 m.id。
interface DiscoveredModel {
  model: string;
  label: string | null;
  caps: CapsUi;
  context_tokens: number | null;
  max_tokens: number | null;
}

export interface AdoptedModel {
  id: string;
  model: string;
  label: string;
  caps: CapsUi;
  context_tokens: string;
}

export interface DiscoverModelsDialogProps {
  /** 打开弹窗时的初始值：已有供应商传其当前快照，新建传一份空白。关闭时传 null。 */
  provider: ProviderUi | null;
  onClose: () => void;
  onAdopt: (baseUrl: string, apiKey: string, models: AdoptedModel[]) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';
const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

function fmtContext(n: number | null): string {
  if (!n || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function DiscoverModelsDialog(props: DiscoverModelsDialogProps) {
  const { provider, t } = props;
  const [endpoint, setEndpoint] = useState(provider?.base_url ?? '');
  const [apiKey, setApiKey] = useState(provider?.api_key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DiscoveredModel[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  if (!provider) return null; // 未打开

  const run = async () => {
    if (!endpoint.trim()) { setError(t('modelSettings.discoverNoBaseUrl')); return; }
    setBusy(true); setError(null);
    try {
      const out = await invoke<{ resolvedBaseUrl: string; models: DiscoveredModel[] }>('ai_fetch_models', {
        input: { endpoint: endpoint.trim(), apiKey: apiKey.trim() || null },
      });
      if (out.models.length === 0) { setError(t('modelSettings.discoverEmpty')); return; }
      setEndpoint(out.resolvedBaseUrl);
      setCandidates(out.models);
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
              <input className={inputCls} value={endpoint} disabled={busy}
                placeholder={t('modelSettings.endpointPlaceholder')}
                onChange={(e) => setEndpoint(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void run(); }} />
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
                  <span className="shrink-0 text-[10px] text-neutral-400 w-12 text-right">{fmtContext(m.context_tokens)}</span>
                  <span className="shrink-0 text-[10px] text-neutral-400 w-16 text-right">
                    {m.caps.vision ? t('modelSettings.caps.vision')
                      : m.caps.reasoning ? t('modelSettings.caps.reasoning')
                      : m.caps.embedding ? t('modelSettings.caps.embedding')
                      : t('modelSettings.caps.text')}
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
