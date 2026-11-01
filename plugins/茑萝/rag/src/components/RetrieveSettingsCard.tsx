// 检索排序设置卡片（2026-11-01 新增）：重排（rerank）阶段配置。
//
// 为什么单独一张卡：嵌入卡片管的是「怎么把文档变成向量」，这张管的是
// 「召回之后怎么排」——两者端点、模型、失败后果都不同，混在一个表单里会让人
// 以为「换了嵌入模型重排也跟着换」。localStorage 也是**两个独立 key**。
//
// ⚠️ 反「假模型」设计（和 embed-config 的三级回落刻意不同）：
//   - 「自动匹配」只在算力来源里挑名字明确写着 rerank/ranker 的档案；
//     挑不到就**不启用**，用灰字写清「已降级为向量排序」，绝不拿对话模型凑数。
//   - 保存前必须真发 2 条短文档探测（相关的必须排在无关的前面），
//     探测不过就不写 enabled=true —— 「配上了但其实是假的」比没配更糟。
//   - 探测的是**表单里当前这份**（未保存也测得准），测的端点和以后用的端点同源。
//
// 文案：中文为主，走 `rag.retrieve.*` 的 7 语言 key（见 src/lib/i18n/locales/*）。

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;

import { t as T, useLang } from '../lib/i18n';
import {
  CANDIDATE_K_MAX,
  CANDIDATE_K_MIN,
  FINAL_K_MAX,
  FINAL_K_MIN,
  RERANK_TIMEOUT_MAX,
  RERANK_TIMEOUT_MIN,
  clearRerankSettings,
  getRerankSettings,
  resolveRerank,
  resolveRerankWith,
  describeRerankProbe,
  rerankModeText,
  saveRerankSettings,
  type RerankMode,
  type RerankSettings,
  type ResolvedRerank,
} from '../retrieve/rerank-config';
import { invalidateQueryCache } from '../retrieve/retriever';
import { ragStore } from '../store/rag-store';

type ChangeEvt = { target: { value: string } };

const INPUT_CLS =
  'rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/80 dark:bg-stone-900/50 px-2 py-1.5 text-xs text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]';
const BTN_CLS =
  'btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-600 dark:text-stone-300 disabled:opacity-50';

/** 表单状态：设置 + 三个数字用字符串存（输入过程允许空/半截数字）。 */
interface FormState {
  enabled: boolean;
  mode: RerankMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  candidateK: string;
  finalK: string;
  timeoutMs: string;
}

function toForm(s: RerankSettings): FormState {
  return {
    enabled: s.enabled,
    mode: s.mode,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model: s.model,
    candidateK: String(s.candidateK),
    finalK: String(s.finalK),
    timeoutMs: String(s.timeoutMs),
  };
}

/** 表单 → 设置（数字字段走 clampInt，非法输入退回默认）。 */
function fromForm(f: FormState, base: RerankSettings): RerankSettings {
  return {
    ...base,
    enabled: f.enabled,
    mode: f.mode,
    baseUrl: f.baseUrl.trim(),
    apiKey: f.apiKey.trim(),
    model: f.model.trim(),
    candidateK: Number(f.candidateK),
    finalK: Number(f.finalK),
    timeoutMs: Number(f.timeoutMs),
  };
}

type Status = { kind: 'ok' | 'err' | 'busy' | 'warn'; text: string } | null;

export function RetrieveSettingsCard() {
  useLang(); // 语言切换时重渲染（文案全走 T()）
  const [form, setForm] = useState<FormState>(() => toForm(getRerankSettings()));
  const [resolved, setResolved] = useState<ResolvedRerank | null>(null);
  const [status, setStatus] = useState<Status>(null);

  /** 重新解析「当前表单」的重排来源（不写库、不写缓存）。 */
  const reload = useCallback(async (f: FormState) => {
    const draft = fromForm(f, getRerankSettings());
    try {
      // enabled 强制 true：探测的是「这份表单如果启用会打到哪」，与开关无关，
      // 这样用户可以先探一下再决定开不开。
      const cfg = await resolveRerankWith({ ...draft, enabled: true });
      setResolved(cfg);
      return cfg;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 解析重排来源失败:', msg);
      setResolved(null);
      setStatus({ kind: 'err', text: msg });
      return null;
    }
  }, []);

  // 初始：显示「已保存配置」的解析结果（关着的时候不探测，避免白白发一次请求）
  useEffect(() => {
    let mounted = true;
    (async () => {
      const cfg = await resolveRerank();
      if (mounted) setResolved(cfg);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // 把当前模式广播给侧栏（侧栏灰字与卡片永远一致，不需要再解析一次）
  useEffect(() => {
    if (!resolved) return;
    ragStore.setRerankInfo({ usable: resolved.usable, text: rerankModeText(resolved) });
  }, [resolved]);

  // 开关 / 模式 / 端点变化时重新解析来源（自动模式要查算力来源）
  useEffect(() => {
    if (!form.enabled) {
      setResolved(null);
      return;
    }
    void reload(form);
    // 只在影响「用哪个端点」的字段上重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.enabled, form.mode, form.baseUrl, form.model, reload]);

  function patch(p: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  /** 探测：用表单当前值真实发 2 条短文档。 */
  async function onProbe(): Promise<Status> {
    setStatus({ kind: 'busy', text: T('rag.retrieve.probing') });
    const cfg = await reload(form);
    if (!cfg) return null;
    if (!cfg.usable) {
      setStatus({ kind: 'warn', text: `${T('rag.retrieve.degraded')}：${cfg.reason}` });
      return null;
    }
    try {
      const text = await describeRerankProbe(cfg);
      setStatus({ kind: 'ok', text });
      return { kind: 'ok', text };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[rag] 重排探测失败:', msg);
      setStatus({ kind: 'err', text: T('rag.retrieve.probeFail', { reason: msg }) });
      return null;
    }
  }

  /** 保存：先探测，探测通过才写 enabled=true（失败就存成关闭 + 明确原因）。 */
  async function onSave() {
    const base = getRerankSettings();
    const next = fromForm(form, base);
    if (!next.enabled) {
      saveRerankSettings(next);
      invalidateQueryCache();
      setForm(toForm(next));
      setStatus({ kind: 'ok', text: T('rag.retrieve.degraded') });
      void resolveRerank(true).then(setResolved);
      return;
    }
    const ok = await onProbe();
    if (!ok) {
      // 探测没过：把 enabled 关掉再存 —— 「存了一个用不了的重排」比不存更坏，
      // 它会让每次提问都白等一次超时。
      const off = { ...next, enabled: false };
      saveRerankSettings(off);
      invalidateQueryCache();
      setForm(toForm(off));
      console.warn('[rag] 重排探测未通过，已按「关闭重排」保存');
      return;
    }
    saveRerankSettings(next);
    invalidateQueryCache();
    setForm(toForm(next));
    void resolveRerank(true).then(setResolved);
  }

  function onClear() {
    clearRerankSettings();
    setForm(toForm(getRerankSettings()));
    setResolved(null);
    invalidateQueryCache();
    setStatus({ kind: 'ok', text: `${T('rag.retrieve.clear')} · ${T('rag.retrieve.degraded')}` });
  }

  const usable = !!resolved?.usable;
  const statusCls =
    status?.kind === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : status?.kind === 'err'
        ? 'text-red-500'
        : status?.kind === 'warn'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-neutral-400 dark:text-stone-500';
  const statusIcon =
    status?.kind === 'ok' ? '✓ ' : status?.kind === 'err' ? '⚠ ' : status?.kind === 'warn' ? '⚠ ' : '… ';

  return (
    <div className="rounded-xl border border-neutral-200/60 dark:border-stone-600/60 bg-white/60 dark:bg-stone-800/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-neutral-500 dark:text-stone-400">
            {T('rag.retrieve.title')} · {form.enabled ? T('rag.retrieve.modeOn') : T('rag.retrieve.modeOff')}
          </div>
          <div
            className="text-[11px] text-neutral-400 dark:text-stone-500 truncate"
            title={resolved?.usable ? `${resolved.endpoint} · ${resolved.model}` : resolved?.reason}
          >
            {resolved
              ? rerankModeText(resolved)
              : form.enabled
                ? T('rag.retrieve.probing')
                : T('rag.retrieve.degradedHint')}
          </div>
        </div>
        {/* 总开关：off 时检索链路逐字等于改造前 */}
        <button
          onClick={() => patch({ enabled: !form.enabled })}
          className={`btn-press text-xs px-2.5 py-1 rounded-lg border ${
            form.enabled
              ? 'bg-[var(--element-bg)] text-white border-transparent'
              : 'border-neutral-200/60 dark:border-stone-600/60 text-neutral-500 dark:text-stone-400'
          }`}
          title={form.enabled ? T('rag.retrieve.modeOn') : T('rag.retrieve.modeOff')}
        >
          {T('rag.retrieve.enable')} {form.enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-neutral-400 dark:text-stone-500">{T('rag.retrieve.mode')}</span>
          <select
            value={form.mode}
            onChange={(e: ChangeEvt) => patch({ mode: e.target.value === 'manual' ? 'manual' : 'auto' })}
            className={INPUT_CLS}
          >
            <option value="auto">{T('rag.retrieve.modeAuto')}</option>
            <option value="manual">{T('rag.retrieve.modeManual')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-neutral-400 dark:text-stone-500">{T('rag.retrieve.candidateK')}</span>
          <input
            type="number"
            min={CANDIDATE_K_MIN}
            max={CANDIDATE_K_MAX}
            value={form.candidateK}
            onChange={(e: ChangeEvt) => patch({ candidateK: e.target.value })}
            className={`${INPUT_CLS} w-20`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-neutral-400 dark:text-stone-500">{T('rag.retrieve.finalK')}</span>
          <input
            type="number"
            min={FINAL_K_MIN}
            max={FINAL_K_MAX}
            value={form.finalK}
            onChange={(e: ChangeEvt) => patch({ finalK: e.target.value })}
            className={`${INPUT_CLS} w-20`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-neutral-400 dark:text-stone-500">{T('rag.retrieve.timeout')}</span>
          <input
            type="number"
            min={RERANK_TIMEOUT_MIN}
            max={RERANK_TIMEOUT_MAX}
            step={500}
            value={form.timeoutMs}
            onChange={(e: ChangeEvt) => patch({ timeoutMs: e.target.value })}
            className={`${INPUT_CLS} w-24`}
          />
        </label>
      </div>

      {form.mode === 'manual' && (
        <div className="mt-2 flex flex-col gap-2">
          <input
            value={form.baseUrl}
            onChange={(e: ChangeEvt) => patch({ baseUrl: e.target.value })}
            placeholder={T('rag.retrieve.baseUrl')}
            className={INPUT_CLS}
          />
          <div className="flex gap-2">
            <input
              value={form.model}
              onChange={(e: ChangeEvt) => patch({ model: e.target.value })}
              placeholder={T('rag.retrieve.model')}
              className={`${INPUT_CLS} flex-1`}
            />
            <input
              value={form.apiKey}
              onChange={(e: ChangeEvt) => patch({ apiKey: e.target.value })}
              placeholder={T('rag.retrieve.apiKey')}
              className={`${INPUT_CLS} flex-1`}
            />
          </div>
        </div>
      )}

      {form.mode === 'auto' && resolved && !usable && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          ⚠ {T('rag.retrieve.noRerankProfile')}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button onClick={() => void onProbe()} className={BTN_CLS}>
          {T('rag.retrieve.probe')}
        </button>
        <button onClick={() => void onSave()} className="btn-press text-xs px-3 py-1.5 rounded-lg bg-[var(--element-bg)] text-white">
          {T('rag.retrieve.save')}
        </button>
        <button onClick={onClear} className="btn-press text-xs px-2 py-1 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700">
          {T('rag.retrieve.clear')}
        </button>
        <span className="text-[11px] text-neutral-400 dark:text-stone-500">{T('rag.retrieve.probeFirst')}</span>
      </div>

      {/* 当前生效区间（灰字）：候选 → 最终，让人一眼知道召回放大了多少 */}
      <div className="mt-1 text-[11px] text-neutral-400 dark:text-stone-500">
        {T('rag.retrieve.range', {
          candidate: resolved?.usable ? resolved.candidateK : Number(form.candidateK) || 0,
          final: resolved?.usable ? resolved.finalK : Number(form.finalK) || 0,
        })}
      </div>

      {status && (
        <div className={`mt-2 text-[11px] ${statusCls}`}>
          {statusIcon}
          {status.text}
        </div>
      )}
    </div>
  );
}
