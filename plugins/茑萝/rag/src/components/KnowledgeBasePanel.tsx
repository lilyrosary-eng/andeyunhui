// 知识库主面板：嵌入端点状态 + 来源列表 + 摄取对话框 + 带引用对话。
//
// 2026-10-18 修复：
//   - 此前 ragInitDb() 用 `catch {}` 静默吞错（沙箱拦截 / 后端异常全不可见），
//     现在失败会 console.error 并在面板顶部显示红色错误条；
//   - 新增嵌入端点卡片，直接显示「当前用哪个端点、哪个模型」，可检测 / 修改 / 重置。

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;

import { ragInitDb, type RagSourceInfo } from '../api/host';
import { ragStore } from '../store/rag-store';
import { IngestDialog } from './IngestDialog';
import { CitedChat } from './CitedChat';
import { EmbedSettingsCard } from './EmbedSettingsCard';

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function KnowledgeBasePanel() {
  const [sources, setSources] = useState<RagSourceInfo[]>([]);
  const [tab, setTab] = useState<'chat' | 'manage'>('chat');
  const [ready, setReady] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await ragStore.refresh();
    setSources(list);
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
  }

  async function onIngested(_info: RagSourceInfo) {
    // 摄取成功后刷新列表并切到管理页
    await refresh();
    setTab('manage');
  }

  const error = initError ?? storeError;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">知识库（RAG）</h2>
        <div className="flex gap-1.5">
          <button
            onClick={() => setTab('chat')}
            className={`btn-press px-3 py-1.5 rounded-lg text-sm ${tab === 'chat' ? 'bg-[var(--element-bg)] text-white' : 'bg-neutral-200/60 dark:bg-stone-700 text-neutral-600 dark:text-stone-300'}`}
          >
            对话
          </button>
          <button
            onClick={() => setTab('manage')}
            className={`btn-press px-3 py-1.5 rounded-lg text-sm ${tab === 'manage' ? 'bg-[var(--element-bg)] text-white' : 'bg-neutral-200/60 dark:bg-stone-700 text-neutral-600 dark:text-stone-300'}`}
          >
            管理
          </button>
        </div>
      </div>

      <EmbedSettingsCard />

      {error && (
        <div className="text-xs text-red-500 rounded-lg border border-red-200/60 dark:border-red-800/40 bg-red-50/60 dark:bg-red-900/20 px-3 py-2">
          ⚠ {error}
        </div>
      )}

      {tab === 'chat' ? (
        <CitedChat />
      ) : (
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-2">摄取新文档</h3>
            <IngestDialog onIngested={onIngested} />
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400">
                已摄取来源（{sources.length}）
              </h3>
              <button
                onClick={refresh}
                className="btn-press text-xs px-2 py-1 rounded-lg border border-neutral-200/60 dark:border-stone-600/60 text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700"
              >
                刷新
              </button>
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
                        {s.type} · {s.chunk_count} 块 · {formatTime(s.created_at)}
                      </div>
                    </div>
                    <button
                      onClick={() => onDelete(s.id)}
                      className="btn-press text-xs px-2 py-1 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      删除
                    </button>
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
