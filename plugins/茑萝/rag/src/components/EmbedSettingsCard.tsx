// 嵌入端点设置卡片（2026-10-18 新增）。
//
// 存在的理由：RAG 的摄取与检索都依赖一个能产出向量的端点。此前插件里没有任何配置入口，
// 默认硬编码 `localhost:11434`（Ollama）——本机没装 Ollama 就必然失败，且用户无从得知
// 失败原因。这里把「当前用的是哪个端点」直接摆到面板上，并提供检测 / 修改 / 重置。
//
// 配置与主应用「AI 对话」的伴侣记忆共用同一个 localStorage key，任一处改都生效。

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;

import {
  resolveEmbedConfig,
  probeEmbedConfig,
  setExplicitConfig,
  clearExplicitConfig,
  getExplicitConfig,
  type EmbedConfig,
} from '../embed/embed-config';

type ChangeEvt = { target: { value: string } };

export function EmbedSettingsCard() {
  const [cfg, setCfg] = useState<EmbedConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null);

  const load = useCallback(async (force = false) => {
    setStatus({ kind: 'busy', text: '解析嵌入端点…' });
    try {
      const c = await resolveEmbedConfig(force);
      setCfg(c);
      setStatus(null);
      setEndpoint((prev) => prev || c.endpoint);
      setModel((prev) => prev || c.model);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 解析嵌入配置失败:', msg);
      setStatus({ kind: 'err', text: `解析失败：${msg}` });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function onEdit() {
    const explicit = getExplicitConfig();
    setEndpoint(explicit?.endpoint ?? cfg?.endpoint ?? '');
    setModel(explicit?.model ?? cfg?.model ?? '');
    setApiKey(explicit?.apiKey ?? cfg?.apiKey ?? '');
    setEditing(true);
    setStatus(null);
  }

  function onSave() {
    const ep = endpoint.trim();
    if (!ep) {
      setStatus({ kind: 'err', text: '端点不能为空（例：https://api.xxx.com/v1/embeddings）' });
      return;
    }
    if (!/^https?:\/\//i.test(ep)) {
      setStatus({ kind: 'err', text: '端点必须以 http:// 或 https:// 开头' });
      return;
    }
    setExplicitConfig({ endpoint: ep, model, apiKey });
    setEditing(false);
    setStatus({ kind: 'ok', text: '已保存，正在重新解析…' });
    void load(true);
  }

  function onReset() {
    clearExplicitConfig();
    setEditing(false);
    setStatus({ kind: 'ok', text: '已清空显式配置，回落到「复用算力来源」' });
    void load(true);
  }

  async function onProbe() {
    if (!cfg) return;
    setStatus({ kind: 'busy', text: '检测中（会真实发一条 ping 请求）…' });
    try {
      const dim = await probeEmbedConfig(cfg);
      setStatus({
        kind: dim > 0 ? 'ok' : 'err',
        text: dim > 0 ? `可用，向量维度 ${dim}` : '端点返回了空向量，检查模型名是否正确',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 嵌入端点检测失败:', msg);
      setStatus({ kind: 'err', text: `不可用：${msg}` });
    }
  }

  const sourceText =
    cfg?.source === 'explicit'
      ? '显式配置'
      : cfg?.source === 'profile'
        ? `复用${cfg.label}`
        : cfg?.source === 'fallback'
          ? 'Ollama 本机兜底（未检测到可用算力来源）'
          : '未知';

  return (
    <div className="rounded-xl border border-neutral-200/60 dark:border-stone-600/60 bg-white/60 dark:bg-stone-800/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-neutral-500 dark:text-stone-400">嵌入端点 · {sourceText}</div>
          <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate" title={cfg?.endpoint}>
            {cfg ? `${cfg.endpoint} · ${cfg.model}` : '解析中…'}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={onProbe}
            disabled={!cfg || status?.kind === 'busy'}
            className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-600 dark:text-stone-300 disabled:opacity-50"
          >
            检测
          </button>
          <button
            onClick={editing ? () => setEditing(false) : onEdit}
            className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-600 dark:text-stone-300"
          >
            {editing ? '取消' : '修改'}
          </button>
          {cfg?.source === 'explicit' && !editing && (
            <button
              onClick={onReset}
              className="btn-press text-xs px-2 py-1 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700"
            >
              重置
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex flex-col gap-2">
          <input
            value={endpoint}
            onChange={(e: ChangeEvt) => setEndpoint(e.target.value)}
            placeholder="https://api.example.com/v1/embeddings"
            className="rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/80 dark:bg-stone-900/50 px-2 py-1.5 text-xs text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]"
          />
          <div className="flex gap-2">
            <input
              value={model}
              onChange={(e: ChangeEvt) => setModel(e.target.value)}
              placeholder="嵌入模型（如 text-embedding-3-small）"
              className="flex-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/80 dark:bg-stone-900/50 px-2 py-1.5 text-xs text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]"
            />
            <input
              value={apiKey}
              onChange={(e: ChangeEvt) => setApiKey(e.target.value)}
              placeholder="API Key（可留空）"
              className="flex-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/80 dark:bg-stone-900/50 px-2 py-1.5 text-xs text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onSave}
              className="btn-press text-xs px-3 py-1.5 rounded-lg bg-[var(--element-bg)] text-white"
            >
              保存
            </button>
            <span className="text-[11px] text-neutral-400 dark:text-stone-500">
              与「AI 对话」的伴侣记忆共用同一份嵌入配置
            </span>
          </div>
        </div>
      )}

      {status && (
        <div
          className={`mt-2 text-[11px] ${
            status.kind === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : status.kind === 'err'
                ? 'text-red-500'
                : 'text-neutral-400'
          }`}
        >
          {status.kind === 'ok' ? '✓ ' : status.kind === 'err' ? '⚠ ' : '… '}
          {status.text}
        </div>
      )}
    </div>
  );
}
