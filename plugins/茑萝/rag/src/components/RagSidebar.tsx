// 知识库侧栏（2026-10-19 新增）。
//
// 为什么放这些：主面板是「宽内容区」，侧栏承担「导航 + 状态速览」——
//  1) 视图切换（对话/图谱/管理）：状态在 ragStore 里，侧栏与主面板共享
//  2) 库规模速览（来源数 / 块数 / 维度分布）：一眼看出"要不要重建"
//  3) 来源列表：点一下跳到管理页（将来可高亮；现在先做成入口）
//  4) 最近提问：点一下把问题投回对话面板（常问的问题不用重打）
//
// 不做的事：不在这里放「摄取」按钮 —— 摄取是低频动作，塞进侧栏会让它看起来像主操作。

const React = window.__HOST_REACT__;
const { useState, useEffect } = React;

import { ragStore, type LastResult, type RagView } from '../store/rag-store';
import { ragStats, type RagSourceInfo, type RagStats } from '../api/host';

const VIEWS: { id: RagView; label: string; hint: string }[] = [
  { id: 'chat', label: '对话', hint: '检索 + 带引用回答' },
  { id: 'graph', label: '图谱', hint: '最近一次检索的命中关系' },
  { id: 'manage', label: '管理', hint: '摄取 / 重建 / 删除' },
];

export function RagSidebar() {
  const [sources, setSources] = useState<RagSourceInfo[]>(() => ragStore.getSources());
  const [view, setView] = useState<RagView>(() => ragStore.getView());
  const [last, setLast] = useState<LastResult | null>(() => ragStore.getLastResult());
  const [stats, setStats] = useState<RagStats | null>(null);

  async function refreshStats() {
    try {
      setStats(await ragStats('general'));
    } catch (e) {
      console.error('[rag] 侧栏统计失败:', e);
      setStats(null);
    }
  }

  useEffect(() => {
    const un1 = ragStore.subscribe((list) => {
      setSources(list);
      void refreshStats();
    });
    const un2 = ragStore.subscribeView((v) => setView(v));
    const un3 = ragStore.subscribeLastResult((r) => setLast(r));
    // 侧栏可能先于主面板挂载：自己拉一次数据（幂等）
    void ragStore.refresh();
    void refreshStats();
    return () => {
      un1();
      un2();
      un3();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dimText =
    stats && stats.dims.length > 0
      ? stats.dims.map((d) => `${d.dim}维`).join(' / ')
      : '';

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* 视图切换 */}
      <div className="flex flex-col gap-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => ragStore.setView(v.id)}
            title={v.hint}
            className={`text-left px-2 py-1.5 rounded-lg text-[13px] transition-colors ${
              view === v.id
                ? 'bg-[var(--element-bg)] text-white'
                : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* 规模速览 */}
      <div className="text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500">
        {stats ? (
          <>
            {stats.sources} 个来源 · {stats.chunks} 块
            {dimText ? <div>{dimText}</div> : null}
            {stats.dims.length > 1 ? (
              <div className="text-amber-600 dark:text-amber-400">维度不一致，需重建</div>
            ) : null}
          </>
        ) : (
          '统计加载中…'
        )}
      </div>

      {/* 来源列表 */}
      <div>
        <div className="text-[11px] text-neutral-400 dark:text-stone-500 mb-1">来源</div>
        {sources.length === 0 ? (
          <div className="text-[11px] text-neutral-400 dark:text-stone-500">暂无来源</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sources.map((s) => (
              <button
                key={s.id}
                onClick={() => ragStore.setView('manage')}
                title={`${s.title} · ${s.chunk_count} 块${s.embed_dim ? ` · ${s.embed_dim} 维` : ''}`}
                className="text-left text-[12px] px-2 py-1 rounded-md truncate text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5"
              >
                {s.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 最近提问 */}
      {last && (
        <div>
          <div className="text-[11px] text-neutral-400 dark:text-stone-500 mb-1">最近提问</div>
          <button
            onClick={() => {
              ragStore.ask(last.query);
              ragStore.setView('chat');
            }}
            title={last.query}
            className="text-left w-full px-2 py-1 rounded-md text-[12px] text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <div className="truncate">{last.query}</div>
            <div className="text-[10px] text-neutral-400 dark:text-stone-500">
              命中 {last.hits.length} 条 · 再问一次
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
