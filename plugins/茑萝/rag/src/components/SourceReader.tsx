// 来源正文阅读器（2026-11-04 新增）。
//
// 对应 Obsidian 的「点开链接落到正文里那一处」：在此之前，点引用只能在对话里就地展开
// 那一小块文本（CitedChat 内联框），用户看不到命中处的前后文，也就无法判断
// 「为什么是这几条被选中」。这里给的是**整篇正文 + 高亮命中区间 + 自动滚过去**。
// 正文怎么从父子两层块里拼出来，见 ../reader/spine.ts。

const React = window.__HOST_REACT__;
const { useState, useEffect, useMemo, useRef } = React;

import { ragListChunks, type RagChunkRow } from '../api/host';
import { ragStore, RAG_NS_GENERAL, type ReaderTarget } from '../store/rag-store';
import { buildSpine, hitSlice } from '../reader/spine';

export function SourceReader() {
  const [target, setTarget] = useState<ReaderTarget | null>(() => ragStore.getReader());
  const [rows, setRows] = useState<RagChunkRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => ragStore.subscribeReader(setTarget), []);

  useEffect(() => {
    let alive = true;
    if (!target) return;
    setRows(null);
    setErr(null);
    ragListChunks(target.sourceId, RAG_NS_GENERAL, true)
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[rag] 读取来源正文失败:', msg);
        if (alive) setErr(`正文读取失败：${msg}`);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  /** 要高亮的区间（没有就只打开正文，不画底色） */
  const anchor = useMemo(
    () =>
      target && target.start !== undefined && target.end !== undefined
        ? { start: target.start, end: target.end }
        : null,
    [target],
  );
  const spine = useMemo(() => (rows ? buildSpine(rows) : null), [rows]);
  /** 命中落在第几段（用于标题行显示「块 #id」并只给这一段画块边界标注）。 */
  const hitIdx = useMemo(() => {
    if (!spine) return -1;
    return spine.findIndex((s) => hitSlice(s, anchor) !== null);
  }, [spine, anchor]);

  // 滚到命中处：等 DOM 里的 <mark> 挂上再滚
  useEffect(() => {
    if (hitIdx >= 0) markRef.current?.scrollIntoView({ block: 'center' });
  }, [hitIdx]);

  if (!target) {
    return (
      <div className="text-xs text-neutral-400 dark:text-stone-500 py-8 text-center">
        没有要看的来源。从「对话」的引用角标或「图谱」的节点点「看原文」进来。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-neutral-700 dark:text-stone-200">
            {ragStore.getSources().find((x) => x.id === target.sourceId)?.title ?? '（这条来源不在列表里）'}
          </div>
          <div className="min-w-0 truncate text-[11px] text-neutral-400 dark:text-stone-500">
            正文
            {target.query ? ` · 来自提问「${target.query}」` : ''}
            {anchor ? ` · 命中区间 [${anchor.start}, ${anchor.end})` : ''}
            {spine ? ` · ${spine.length} 段` : ''}
          </div>
        </div>
        <button
          onClick={() => ragStore.closeReader()}
          className="btn-press shrink-0 rounded border border-neutral-300/70 px-2 py-0.5 hover:bg-black/5 dark:border-stone-600 dark:hover:bg-white/10"
        >
          ← 返回
        </button>
      </div>

      {err && (
        <div className="text-xs text-red-500 rounded-lg border border-red-200/60 dark:border-red-800/40 bg-red-50/60 dark:bg-red-900/20 px-3 py-2">
          ⚠ {err}
        </div>
      )}
      {!err && !spine && <div className="text-xs text-neutral-400 py-6 text-center">正文读取中…</div>}
      {spine && spine.length === 0 && (
        <div className="text-xs text-neutral-400 py-6 text-center">这条来源在库里没有可读的分块。</div>
      )}

      {spine && spine.length > 0 && (
        <div className="rounded-xl border border-neutral-200/60 dark:border-stone-600/60 bg-white/60 dark:bg-stone-900/40 px-4 py-3 max-h-[60vh] overflow-auto">
          {spine.map((seg, i) => {
            const hs = hitSlice(seg, anchor);
            const pre = hs ? seg.text.slice(0, hs.from) : seg.text;
            const mark = hs ? seg.text.slice(hs.from, hs.to) : '';
            const post = hs ? seg.text.slice(hs.to) : '';
            return (
              <div key={`${seg.id}-${i}`}>
                {hs && (
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500 mb-1">
                    命中所在块 #{seg.idx} · [{seg.char_start}, {seg.char_start + seg.text.length})
                  </div>
                )}
                <p className="text-[12.5px] leading-6 whitespace-pre-wrap text-neutral-700 dark:text-stone-200">
                  {pre}
                  {hs && (
                    <mark
                      ref={markRef as any}
                      className="bg-amber-200/70 dark:bg-amber-500/30 text-inherit rounded-[2px] px-0.5"
                    >
                      {mark}
                    </mark>
                  )}
                  {post}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
