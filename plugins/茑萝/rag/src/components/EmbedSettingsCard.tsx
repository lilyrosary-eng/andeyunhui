// 嵌入端点**状态**卡（2026-10-18 新增；2026-11-05 改成只读）。
//
// 为什么不再有输入框：同一份嵌入配置此前长在三个界面上（这张卡、AI 对话的记忆面板、移动端设置），
// 而且这里的优先级顺序还和运行时不一致。唯一入口现在是
// **设置 → 模型 → 「嵌入模型（RAG 记忆 / 知识库）」**。
// 这张卡只负责三件事：显示当前**真正会用**的端点/模型/来源、真发一次检测、
// 没配的时候给出能执行的下一步（而不是悄悄拿 Ollama 试）。

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;

import { resolveEmbedConfig, probeEmbedConfig, type EmbedConfig } from '../embed/embed-config';

/** 打开 设置 → 模型。navigate 只负责切模块，落哪个 tab 由宿主的事件监听决定；
 *  而设置面板是懒挂载的 —— 所以先切模块，等它挂上再补发事件，顺序不能反。 */
function gotoEmbedSettings() {
  window.__HOST_API__?.navigate?.({ module: 'settings', props: { tab: 'model' } });
  window.setTimeout(
    () => window.dispatchEvent(new CustomEvent('open-global-settings', { detail: { tab: 'model' } })),
    150,
  );
}

const SOURCE_TEXT: Record<EmbedConfig['source'], string> = {
  routing: '路由页选定',
  explicit: '手动端点（高级）',
  profile: '自动猜测',
};

export function EmbedSettingsCard() {
  const [cfg, setCfg] = useState<EmbedConfig | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null);

  const load = useCallback(async (force = false) => {
    setStatus({ kind: 'busy', text: '解析嵌入端点…' });
    try {
      setCfg(await resolveEmbedConfig(force));
      setMissing(null);
      setStatus(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 未配置不再是"静默兜底"，而是显式失败：这里把它摆出来并给出去设置的入口
      console.error('[rag] 解析嵌入配置失败:', msg);
      setCfg(null);
      setMissing(msg);
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const dot =
    !cfg
      ? 'text-red-500'
      : cfg.source === 'profile'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-emerald-600 dark:text-emerald-400';

  return (
    <div className="rounded-xl border border-neutral-200/60 dark:border-stone-600/60 bg-white/60 dark:bg-stone-800/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-xs ${dot}`}>
            嵌入端点{cfg ? ` · ${SOURCE_TEXT[cfg.source]}` : ' · 未配置'}
          </div>
          <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate" title={cfg?.endpoint}>
            {cfg ? `${cfg.endpoint} · ${cfg.model}` : '对话沉淀与文档摄取当前都不会执行'}
          </div>
          {cfg?.source === 'profile' && (
            <div className="text-[10px] text-amber-600 dark:text-amber-400">
              这是自动猜出来的端点，可能不是你想要的（维度不符会让旧数据检索不到）——建议去显式选定。
            </div>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={() => void load(true)}
            className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-600 dark:text-stone-300"
          >
            重新解析
          </button>
          <button
            onClick={onProbe}
            disabled={!cfg || status?.kind === 'busy'}
            className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-600 dark:text-stone-300 disabled:opacity-50"
          >
            检测
          </button>
          <button
            onClick={gotoEmbedSettings}
            className="btn-press text-xs px-2 py-1 rounded-lg bg-[var(--element-bg)] text-white"
          >
            去设置
          </button>
        </div>
      </div>

      {missing && (
        <div className="mt-2 text-[11px] text-red-500 rounded-lg border border-red-200/60 dark:border-red-800/40 bg-red-50/60 dark:bg-red-900/20 px-2.5 py-1.5">
          ⚠ {missing}
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
