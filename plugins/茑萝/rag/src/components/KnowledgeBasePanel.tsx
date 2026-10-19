// 知识库主面板：嵌入端点状态 + 来源列表 + 摄取对话框 + 带引用对话。
//
// 2026-10-18 修复：
//   - 此前 ragInitDb() 用 `catch {}` 静默吞错（沙箱拦截 / 后端异常全不可见），
//     现在失败会 console.error 并在面板顶部显示红色错误条；
//   - 新增嵌入端点卡片，直接显示「当前用哪个端点、哪个模型」，可检测 / 修改 / 重置。

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef } = React;

import { ragInitDb, ragStats, type RagSourceInfo, type RagStats } from '../api/host';
import { ragStore, type RagView } from '../store/rag-store';
import { reembedSource, reembedAll, type ReembedProgress } from '../ingest/reembed';
import { invalidateQueryCache } from '../retrieve/retriever';
import { IngestDialog } from './IngestDialog';
import { CitedChat } from './CitedChat';
import { HitGraph } from './HitGraph';
import { EmbedSettingsCard } from './EmbedSettingsCard';

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function phaseText(p: ReembedProgress): string {
  if (p.phase === 'reading') return '读取块…';
  if (p.phase === 'writing') return '写回向量…';
  if (p.phase === 'done') return '完成';
  return `嵌入中 ${p.done}/${p.total}`;
}

export function KnowledgeBasePanel() {
  const [sources, setSources] = useState<RagSourceInfo[]>([]);
  const [view, setViewLocal] = useState<RagView>(() => ragStore.getView());
  // 切换视图统一走 store：侧栏与主面板共享同一个 view
  const setView = useCallback((v: RagView) => ragStore.setView(v), []);
  useEffect(() => {
    const un = ragStore.subscribeView((v) => setViewLocal(v));
    return un;
  }, []);
  const [ready, setReady] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [stats, setStats] = useState<RagStats | null>(null);
  const [rebuilding, setRebuilding] = useState<{ id: string; p: ReembedProgress } | null>(null);
  const [rebuildAll, setRebuildAll] = useState<{
    idx: number;
    total: number;
    title: string;
    p: ReembedProgress;
  } | null>(null);
  const [reembedMsg, setReembedMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });

  const refresh = useCallback(async () => {
    const list = await ragStore.refresh();
    setSources(list);
    try {
      setStats(await ragStats('general'));
    } catch (e) {
      console.error('[rag] 读取统计失败:', e);
      setStats(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await ragInitDb();
        if (mounted) setInitError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 显式打印：这类错误历史上被 catch {} 吞掉，导致「面板空白」无从排查
        console.error('[rag] 初始化数据库失败:', msg);
        if (mounted) setInitError(`知识库初始化失败：${msg}`);
      }
      if (mounted) setReady(true);
      await refresh();
    })();
    const unsub = ragStore.subscribe((list) => setSources(list));
    const unsubErr = ragStore.onError((e) => setStoreError(e));
    return () => {
      mounted = false;
      unsub();
      unsubErr();
    };
  }, [refresh]);

  async function onDelete(id: string) {
    await ragStore.remove(id);
    invalidateQueryCache();
  }

  async function onIngested(_info: RagSourceInfo) {
    // 摄取成功后刷新列表并切到管理页
    invalidateQueryCache();
    await refresh();
    setView('manage');
  }

  /** 重建单个来源的向量（换嵌入模型后用，不需要重新上传文件）。 */
  async function onReembed(id: string, title: string) {
    if (rebuilding) return;
    abortRef.current = { aborted: false };
    setReembedMsg(null);
    setRebuilding({ id, p: { phase: 'reading', done: 0, total: 0 } });
    try {
      const r = await reembedSource(id, {
        signal: abortRef.current,
        onProgress: (p) => setRebuilding({ id, p }),
      });
      setReembedMsg({
        kind: 'ok',
        text: `「${title}」重建完成：${r.blocks} 块 · ${r.dim} 维 · ${r.model}（覆盖前已自动备份，保留最近 3 份）`,
      });
      invalidateQueryCache();
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 重建失败:', msg);
      setReembedMsg({ kind: 'err', text: msg });
    } finally {
      setRebuilding(null);
    }
  }

  function onCancelReembed() {
    abortRef.current.aborted = true;
    console.info('[rag] 用户取消重建');
  }

  /** 一键重建全部来源（每个来源独立事务：失败/取消只影响未完成的）。 */
  async function onReembedAll() {
    if (rebuilding || rebuildAll) return;
    abortRef.current = { aborted: false };
    setReembedMsg(null);
    try {
      const r = await reembedAll({
        signal: abortRef.current,
        onProgress: (p) =>
          setRebuildAll({ idx: p.sourceIdx, total: p.sourceTotal, title: p.title, p: p.p }),
      });
      const failText = r.failed.length
        ? `；失败 ${r.failed.length} 个：${r.failed.map((f) => f.title).join('、')}`
        : '';
      setReembedMsg({
        kind: r.failed.length ? 'err' : 'ok',
        text: `全部重建完成：${r.sources} 个来源 / ${r.blocks} 块${failText}（覆盖前已自动备份）`,
      });
      invalidateQueryCache();
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 全部重建失败:', msg);
      setReembedMsg({ kind: 'err', text: msg });
    } finally {
      setRebuildAll(null);
    }
  }

  const error = initError ?? storeError;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">知识库（RAG）</h2>
        <div className="flex gap-1.5">
          <button
            onClick={() => setView('chat')}
            className={`btn-press px-3 py-1.5 rounded-lg text-sm ${view === 'chat' ? 'bg-[var(--element-bg)] text-white' : 'bg-neutral-200/60 dark:bg-stone-700 text-neutral-600 dark:text-stone-300'}`}
          >
            对话
          </button>
          <button
            onClick={() => setView('graph')}
            className={`btn-press px-3 py-1.5 rounded-lg text-sm ${view === 'graph' ? 'bg-[var(--element-bg)] text-white' : 'bg-neutral-200/60 dark:bg-stone-700 text-neutral-600 dark:text-stone-300'}`}
          >
            图谱
          </button>
          <button
            onClick={() => setView('manage')}
            className={`btn-press px-3 py-1.5 rounded-lg text-sm ${view === 'manage' ? 'bg-[var(--element-bg)] text-white' : 'bg-neutral-200/60 dark:bg-stone-700 text-neutral-600 dark:text-stone-300'}`}
          >
            管理
          </button>
        </div>
      </div>

      <EmbedSettingsCard />

      {stats && stats.dims.length > 1 && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 rounded-lg border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/60 dark:bg-amber-900/20 px-3 py-2">
          库里存在多种向量维度：{stats.dims.map((d) => `${d.dim} 维 × ${d.chunks}`).join(' / ')}。
          与当前模型维度不同的块**不会被检索到**（数据没丢）—— 在「管理」里点来源右侧「重建」即可恢复。
        </div>
      )}

      {error && (
        <div className="text-xs text-red-500 rounded-lg border border-red-200/60 dark:border-red-800/40 bg-red-50/60 dark:bg-red-900/20 px-3 py-2">
          ⚠ {error}
        </div>
      )}

      {view === 'chat' && <CitedChat />}

      {view === 'graph' && <HitGraph />}

      {view === 'manage' && (
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-2">摄取新文档</h3>
            <IngestDialog onIngested={onIngested} />
          </section>

          {(rebuilding || rebuildAll) && (
            <div className="flex items-center justify-between text-[11px] rounded-lg border border-sky-200/60 dark:border-sky-800/40 bg-sky-50/60 dark:bg-sky-900/20 px-3 py-2 text-sky-700 dark:text-sky-300">
              <span>
                {rebuildAll
                  ? `全部重建 ${rebuildAll.idx + 1}/${rebuildAll.total} · 「${rebuildAll.title}」${phaseText(rebuildAll.p)}`
                  : `正在重建向量：${phaseText(rebuilding!.p)}`}
              </span>
              <button onClick={onCancelReembed} className="btn-press px-2 py-0.5 rounded border border-current">
                取消
              </button>
            </div>
          )}

          {reembedMsg && (
            <div className={`text-[11px] ${reembedMsg.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
              {reembedMsg.kind === 'ok' ? '✓ ' : '⚠ '}
              {reembedMsg.text}
            </div>
          )}

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400">
                已摄取来源（{sources.length}）
              </h3>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={onReembedAll}
                  disabled={!!rebuilding || !!rebuildAll || sources.length === 0}
                  title="把全部来源按原文重算一遍向量（每个来源独立事务，失败只跳过它）"
                  className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700 disabled:opacity-40"
                >
                  全部重建
                </button>
                <button
                  onClick={refresh}
                  className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700"
                >
                  刷新
                </button>
              </div>
            </div>
            {!ready ? (
              <div className="text-xs text-neutral-400">初始化中…</div>
            ) : sources.length === 0 ? (
              <div className="text-xs text-neutral-400">暂无来源，先摄取文档吧。</div>
            ) : (
              <div className="flex flex-col gap-2">
                {sources.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/60 dark:bg-stone-800/50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-neutral-700 dark:text-stone-200 truncate">{s.title}</div>
                      <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                        {s.type} · {s.chunk_count} 块
                        {s.embed_dim ? ` · ${s.embed_dim} 维` : ''}
                        {s.embed_model ? ` · ${s.embed_model}` : ''}
                        {' · '}
                        {formatTime(s.created_at)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => onReembed(s.id, s.title)}
                        disabled={!!rebuilding || !!rebuildAll}
                        title="用库里已有的原文重新算一遍向量（换嵌入模型后用这个，不需要重新上传文件）"
                        className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700 disabled:opacity-40"
                      >
                        {rebuilding?.id === s.id ? phaseText(rebuilding.p) : '重建'}
                      </button>
                      <button
                        onClick={() => onDelete(s.id)}
                        disabled={!!rebuilding || !!rebuildAll}
                        className="btn-press text-xs px-2 py-1 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
