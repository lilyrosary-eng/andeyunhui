// 带引用对话组件：用户提问 → 语义检索 → 拼装 RAG 上下文 → 流式生成答案 + 引用来源。
//
// 2026-10-18 修复：
//   - 加最低相似度阈值（默认 0.2）：此前 top-6 **无条件**全塞进 prompt，即使全是无关块，
//     模型也会被强行"依据上下文"作答 —— 这是 RAG 幻觉的主要来源之一；
//   - 引用 chip 显示真实分数，点开可看命中原文（便于核对是不是模型自己编的）；
//   - 检索/嵌入失败不再只显示一句原始错误，会带上端点信息（由 retriever 包装）。

const React = window.__HOST_REACT__;
const { useState, useEffect, useRef } = React;

import { retrieve } from '../retrieve/retriever';
import { RagPromptBuilder } from '../prompt/rag-prompt';
import { streamAiChat, type RagHit } from '../api/host';
import { ragStore } from '../store/rag-store';

/** 相似度「绝对底线」：低于它的命中一律视为噪声。
 *  注意这只是兜底 —— 本机实测 nomic-embed-text-v1.5 连「今天天气不错」都能到 0.68，
 *  所以单靠绝对阈值筛不掉无关内容（见下方相对窗口）。 */
const MIN_SCORE = 0.2;
/** 相对窗口：只保留与 top1 相差不超过这个量的命中。
 *  实测（nomic-embed-text-v1.5，2026-10-19）：相关 0.84~0.91，无关 0.68 ⇒ 0.10 的窗口能干净切开；
 *  固定阈值做不到这件事，因为不同模型的分数分布完全不可比。 */
const REL_WINDOW = 0.1;

/** 按「绝对底线 + 相对 top1 窗口」筛命中。返回保留项与被丢弃数量。 */
function selectHits(hits: RagHit[]): { kept: RagHit[]; dropped: number } {
  const base = hits.filter((h) => h.score >= MIN_SCORE);
  if (base.length === 0) return { kept: [], dropped: hits.length };
  const top1 = Math.max(...base.map((h) => h.score));
  const kept = base.filter((h) => h.score >= top1 - REL_WINDOW);
  return { kept, dropped: hits.length - kept.length };
}

function genRequestId(): string {
  return 'rag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function CitedChat() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [hits, setHits] = useState<RagHit[]>([]);
  const [dropped, setDropped] = useState(0);
  const [dimSkipped, setDimSkipped] = useState(0);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [noHit, setNoHit] = useState(false);
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
    try {
      const res = await retrieve(q, { topK: 6, minScore: MIN_SCORE });
      const { kept, dropped: droppedCount } = selectHits(res.results);
      setDropped(droppedCount);
      setDimSkipped(res.skipped_dim ?? 0);
      setHits(kept);
      // 同步给「图谱」视图（避免用户切过去还要再问一次）
      ragStore.setLastResult({ query: q, hits: kept, dropped: droppedCount, at: Date.now() });

      const builder = new RagPromptBuilder();
      builder.set(
        kept.map((r) => ({
          source_title: r.source_title,
          text: r.text,
          score: r.score,
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
          {hits.map((h, i) => (
            <button
              key={i}
              onClick={() => setOpenIdx(openIdx === i ? null : i)}
              className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/40"
              title={`${h.source_title}（相似度 ${h.score.toFixed(3)}）— 点击查看命中原文`}
            >
              📚 {h.source_title} · {h.score.toFixed(2)}
            </button>
          ))}
        </div>
      )}

      {openIdx !== null && hits[openIdx] && (
        <div className="text-[11px] whitespace-pre-wrap rounded-lg border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10 px-3 py-2 text-neutral-600 dark:text-stone-300 max-h-40 overflow-auto">
          {hits[openIdx].text}
          <div className="mt-1 text-neutral-400 dark:text-stone-500">
            字符区间 [{hits[openIdx].char_start}, {hits[openIdx].char_end}) · 相似度{' '}
            {hits[openIdx].score.toFixed(4)}
          </div>
        </div>
      )}

      {dropped > 0 && (
        <div className="text-[11px] text-neutral-400 dark:text-stone-500">
          已过滤 {dropped} 段（相似度低于 {MIN_SCORE.toFixed(2)}，或比最高分低超过{' '}
          {REL_WINDOW.toFixed(2)}）——未计入上下文
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
