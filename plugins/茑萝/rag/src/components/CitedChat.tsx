// 带引用对话组件：用户提问 → 语义检索 →（可选）重排 → 拼装 RAG 上下文 → 流式生成答案 + 引用来源。
//
// 2026-10-18 修复：
//   - 加最低相似度阈值（默认 0.2）：此前 top-6 **无条件**全塞进 prompt，即使全是无关块，
//     模型也会被强行"依据上下文"作答 —— 这是 RAG 幻觉的主要来源之一；
//   - 引用 chip 显示真实分数，点开可看命中原文（便于核对是不是模型自己编的）；
//   - 检索/嵌入失败不再只显示一句原始错误，会带上端点信息（由 retriever 包装）。
//
// 2026-11-01（重排）：阈值分两套，**不可互换**：
//   - 未启用重排：沿用旧口径 = 余弦绝对底线 0.2 + 与 top1 相差 ≤0.1 的相对窗口。
//   - 启用重排：只看 rerank 分的相对窗口（比例式）。0.2 这个数是**余弦尺度**，
//     对 0~1 且分布随模型完全不同的 rerank 分毫无意义 —— 拿它当闸门会把候选全砍掉，
//     表现成「开了重排反而搜不到东西」。

const React = window.__HOST_REACT__;
const { useState, useEffect, useRef } = React;

import { retrieve, effectiveScore, scoreLabel } from '../retrieve/retriever';
import { RagPromptBuilder } from '../prompt/rag-prompt';
import { streamAiChat, type RagHit } from '../api/host';
import { ragStore } from '../store/rag-store';
import { t as T, useLang } from '../lib/i18n';

/** 相似度「绝对底线」：低于它的命中一律视为噪声（**仅余弦尺度**，重排模式不用它）。
 *  注意这只是兜底 —— 本机实测 nomic-embed-text-v1.5 连「今天天气不错」都能到 0.68，
 *  所以单靠绝对阈值筛不掉无关内容（见下方相对窗口）。 */
const MIN_SCORE = 0.2;
/** 相对窗口（余弦）：只保留与 top1 相差不超过这个量的命中。
 *  实测（nomic-embed-text-v1.5，2026-10-19）：相关 0.84~0.91，无关 0.68 ⇒ 0.10 的窗口能干净切开；
 *  固定阈值做不到这件事，因为不同模型的分数分布完全不可比。 */
const REL_WINDOW = 0.1;
/** 相对窗口（重排分）：保留 ≥ top1 × 这个比例的命中。
 *  用**比例**而不是减法窗口，因为不同 rerank 模型的分数尺度差异极大
 *  （Cohere 常见 0.9/0.02，本地 bge-reranker 常见 0.3/0.001）——
 *  写死 0.1 的减法窗口在前者几乎不过滤、在后者几乎全滤掉。 */
const RERANK_REL_RATIO = 0.2;

/** 按当前排序模式筛命中；返回保留项与被丢弃数量。 */
function selectHits(hits: RagHit[], reranked: boolean): { kept: RagHit[]; dropped: number } {
  if (!reranked) {
    const base = hits.filter((h) => h.score >= MIN_SCORE);
    if (base.length === 0) return { kept: [], dropped: hits.length };
    const top1 = Math.max(...base.map((h) => h.score));
    const kept = base.filter((h) => h.score >= top1 - REL_WINDOW);
    return { kept, dropped: hits.length - kept.length };
  }
  // 重排模式：只按 rerank 分的相对窗口，**不碰余弦阈值**。
  const scored = hits.filter((h) => typeof h.rerank_score === 'number');
  if (scored.length === 0) return { kept: hits, dropped: 0 };
  const top1 = Math.max(...scored.map((h) => h.rerank_score as number));
  const cut = top1 * RERANK_REL_RATIO;
  const kept = hits.filter(
    // 没被打分的候选（端点只回了一部分）不因「没分」被砍掉，交给向量位次兜着
    (h) => h.rerank_score === undefined || h.rerank_score >= cut,
  );
  return { kept, dropped: hits.length - kept.length };
}

function genRequestId(): string {
  return 'rag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function CitedChat() {
  useLang(); // 语言切换时重渲染（引用 chip 的模式文案走 T()）
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [hits, setHits] = useState<RagHit[]>([]);
  const [dropped, setDropped] = useState(0);
  const [dimSkipped, setDimSkipped] = useState(0);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [noHit, setNoHit] = useState(false);
  /** 本次检索是否真的走了重排（false = 向量排序）。 */
  const [reranked, setReranked] = useState(false);
  /** 重排相关说明（灰字：降级原因 / 部分候选没被打分的提示）。 */
  const [rerankNote, setRerankNote] = useState('');
  /** 「候选 N → 最终 M」的候选数（走了重排才显示）。 */
  const [candidates, setCandidates] = useState(0);
  const stopRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    // 侧栏「再问一次」：把问题填进输入框（不自动发，避免误触耗 token）
    const un = ragStore.onAsk((q) => {
      setQuestion(q);
      console.info('[rag] 从侧栏回填问题:', q);
    });
    return un;
  }, []);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer('');
    setHits([]);
    setDropped(0);
    setDimSkipped(0);
    setOpenIdx(null);
    setError('');
    setNoHit(false);
    setReranked(false);
    setRerankNote('');
    setCandidates(0);
    try {
      // topK / minScore 只在**未启用重排**时生效（启用后由设置里的 candidateK→finalK 决定，
      // 且不能把余弦阈值 0.2 传给重排语义 —— 见 retriever 与本文件顶部注释）。
      const res = await retrieve(q, { topK: 6, minScore: MIN_SCORE });
      const { kept, dropped: droppedCount } = selectHits(res.results, res.reranked);
      setDropped(droppedCount);
      setDimSkipped(res.skipped_dim ?? 0);
      setHits(kept);
      setReranked(res.reranked);
      setRerankNote(res.rerankNote ?? '');
      setCandidates(res.candidates ?? kept.length);
      // 同步给「图谱」视图（避免用户切过去还要再问一次）
      ragStore.setLastResult({
        query: q,
        hits: kept,
        dropped: droppedCount,
        reranked: res.reranked,
        at: Date.now(),
      });

      const builder = new RagPromptBuilder();
      builder.set(
        kept.map((r) => ({
          source_title: r.source_title,
          text: r.text,
          score: r.score,
          // 重排分一起给：prompt 里标「相关度」比标「相似度」更贴近真实依据
          rerank_score: r.rerank_score,
        })),
      );
      const msgs = builder.buildMessages(q);
      if (kept.length === 0) setNoHit(true);

      stopRef.current = await streamAiChat({
        requestId: genRequestId(),
        messages: msgs,
        onDelta: (d) => setAnswer((prev) => prev + d),
        onDone: () => {
          setBusy(false);
          stopRef.current?.();
          stopRef.current = null;
        },
        onError: (e) => {
          console.error('[rag] 生成失败:', e);
          setError(e);
          setBusy(false);
          stopRef.current?.();
          stopRef.current = null;
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 检索失败:', msg);
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <textarea
          value={question}
          onChange={(e: { target: { value: string } }) => setQuestion(e.target.value)}
          onKeyDown={(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; preventDefault: () => void }) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder="向知识库提问…（Enter 发送，Ctrl/⌘+Enter 换行）"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/70 dark:bg-stone-800/70 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]"
        />
        <button
          onClick={ask}
          disabled={busy || !question.trim()}
          className="btn-press px-4 rounded-lg bg-[var(--element-bg)] text-white text-sm disabled:opacity-50"
        >
          {busy ? '生成中…' : '提问'}
        </button>
      </div>

      {hits.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {hits.map((h, i) => {
            const label = scoreLabel(h);
            const moved =
              h.rerank_score !== undefined && h.original_rank !== undefined && h.original_rank !== i + 1
                ? ` · 向量第 ${h.original_rank}`
                : '';
            return (
              <button
                key={i}
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${
                  h.rerank_score !== undefined
                    ? 'bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 border-sky-200/60 dark:border-sky-800/40'
                    : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200/60 dark:border-amber-800/40'
                }`}
                title={`${h.source_title}（${label} ${effectiveScore(h).toFixed(3)}${
                  h.rerank_score !== undefined ? ` · 向量 ${h.score.toFixed(3)}` : ''
                }）${moved} — 点击查看命中原文`}
              >
                📚 {h.source_title} · {effectiveScore(h).toFixed(2)}
              </button>
            );
          })}
        </div>
      )}

      {openIdx !== null && hits[openIdx] && (
        <div className="text-[11px] whitespace-pre-wrap rounded-lg border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10 px-3 py-2 text-neutral-600 dark:text-stone-300 max-h-40 overflow-auto">
          {hits[openIdx].text}
          <div className="mt-1 text-neutral-400 dark:text-stone-500">
            字符区间 [{hits[openIdx].char_start}, {hits[openIdx].char_end}) · {scoreLabel(hits[openIdx])}{' '}
            {effectiveScore(hits[openIdx]).toFixed(4)}
            {hits[openIdx].rerank_score !== undefined
              ? ` · 向量 ${hits[openIdx].score.toFixed(4)}（原第 ${hits[openIdx].original_rank}）`
              : ''}
          </div>
        </div>
      )}

      {/* 排序模式说明：重排生效时给「候选 → 最终」，没生效时保持原有的过滤提示口径 */}
      {reranked && (
        <div className="text-[11px] text-sky-600 dark:text-sky-400">
          {T('rag.retrieve.range', { candidate: candidates, final: hits.length })} ·{' '}
          {T('rag.retrieve.rerankBadge')}
        </div>
      )}

      {!reranked && dropped > 0 && (
        <div className="text-[11px] text-neutral-400 dark:text-stone-500">
          已过滤 {dropped} 段（相似度低于 {MIN_SCORE.toFixed(2)}，或比最高分低超过{' '}
          {REL_WINDOW.toFixed(2)}）——未计入上下文
        </div>
      )}

      {reranked && dropped > 0 && (
        <div className="text-[11px] text-neutral-400 dark:text-stone-500">
          已过滤 {dropped} 段（重排分低于最高分的 {(RERANK_REL_RATIO * 100).toFixed(0)}%）——未计入上下文
        </div>
      )}

      {/* 灰字：开了重排但这次没用上（端点没配好 / 调用失败 / 超时） */}
      {!reranked && rerankNote && (
        <div className="text-[11px] text-neutral-400 dark:text-stone-500">
          {T('rag.retrieve.degraded')}：{rerankNote}
        </div>
      )}

      {noHit && (
        <div className="text-xs text-neutral-400 dark:text-stone-500">
          知识库中未找到相关信息，以下回答由模型通用知识生成（可能不准确）。
        </div>
      )}

      {dimSkipped > 0 && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          有 {dimSkipped} 块是用别的嵌入模型建的（向量维度不同），本次未参与检索。
          换了模型后旧块需要按原文重建向量，才能被新模型检索到。
        </div>
      )}

      {answer && (
        <div className="whitespace-pre-wrap rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/40 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 max-h-72 overflow-auto">
          {answer}
        </div>
      )}

      {error && <div className="text-xs text-red-500">⚠ {error}</div>}
    </div>
  );
}
