// 带引用对话组件：用户提问 → 语义检索 → 拼装 RAG 上下文 → 流式生成答案 + 引用来源。
//
// 2026-10-18 修复：
//   - 加最低相似度阈值（默认 0.2）：此前 top-6 **无条件**全塞进 prompt，即使全是无关块，
//     模型也会被强行"依据上下文"作答 —— 这是 RAG 幻觉的主要来源之一；
//   - 引用 chip 显示真实分数，点开可看命中原文（便于核对是不是模型自己编的）；
//   - 检索/嵌入失败不再只显示一句原始错误，会带上端点信息（由 retriever 包装）。

const React = window.__HOST_REACT__;
const { useState, useRef } = React;

import { retrieve } from '../retrieve/retriever';
import { RagPromptBuilder } from '../prompt/rag-prompt';
import { streamAiChat, type RagHit } from '../api/host';

/** 最低相似度阈值：低于它的命中视为无关，不进上下文。 */
const MIN_SCORE = 0.2;

function genRequestId(): string {
  return 'rag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function CitedChat() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [hits, setHits] = useState<RagHit[]>([]);
  const [dropped, setDropped] = useState(0);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [noHit, setNoHit] = useState(false);
  const stopRef = useRef<null | (() => void)>(null);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer('');
    setHits([]);
    setDropped(0);
    setOpenIdx(null);
    setError('');
    setNoHit(false);
    try {
      const res = await retrieve(q, { topK: 6, minScore: MIN_SCORE });
      const kept = res.results.filter((r) => r.score >= MIN_SCORE);
      setDropped(res.results.length - kept.length);
      setHits(kept);

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
          已过滤 {dropped} 段相似度低于 {MIN_SCORE.toFixed(2)} 的命中（未计入上下文）
        </div>
      )}

      {noHit && (
        <div className="text-xs text-neutral-400 dark:text-stone-500">
          知识库中未找到相关信息，以下回答由模型通用知识生成（可能不准确）。
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
